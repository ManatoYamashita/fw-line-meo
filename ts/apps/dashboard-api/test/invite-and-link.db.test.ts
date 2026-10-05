import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool, findActiveInviteCode, createPendingDashboardUser } from '@fwlm/db';
import { createApp } from '../src/app.js';
import type { TokenVerifier, VerifiedToken } from '../src/auth.js';
import { buildAppDeps } from '../src/composition.js';
import { loadConfig, type DashboardApiConfig } from '../src/config.js';

// 実 postgres（ts-test-db）＋実 @fwlm/db で、配線済み dashboard-api の 2 つの横断的不変条件を
// app.request 経由で END-TO-END 検証する（6.2）。
//   A. 招待コードのクロス spec 整合: ダッシュボードが発行したコードが LINE オンボーディングの解決経路
//      （findActiveInviteCode）で使え、無効化すると解決しなくなる（Req 5.2, 5.3）。
//   B. 初回 Google ログイン時リンク（案B・research.md 127-134 / design.md 197-231）: 検証済み Google
//      メール（google.com かつ email_verified）のときのみ保留行へ auth_subject を原子的に埋め、
//      非 Google・未検証・無効化済みは拒否（乗っ取り防止・Req 1.2, 6.2, 6.4）。
// firebase-admin は Bearer 文字列 → VerifiedToken のマップに隔離し、トークンごとに
// email/emailVerified/signInProvider を変えてリンク可否のケース 3–6 を駆動する。
// DATABASE_URL 無しは skip。共有 DB のため UUID prefix は f7（f5=app-routes / f6=store-registration）。

const OP1 = 'f7000000-0000-0000-0000-000000000001';
const AG_A = 'f7000000-0000-0000-0000-000000000002'; // 招待コード発行・保留利用者の所属代理店

// 既に auth_subject が設定済みの利用者トークン（findByAuthSubject が UID で直接解決する）。
const OP_TOKEN = 'f7-op-uid';
const DISABLED_TOKEN = 'f7-disabled-uid';

// リンク候補トークン（findByAuthSubject 不在 → 検証済みクレームでリンク可否を判定させる）。
const LINK_NEW_UID = 'f7-new-uid'; // ケース3: google.com + verified（リンク成立）
const NOPASS_UID = 'f7-nopass-uid'; // ケース4: password（非 Google・リンクしない）
const UNVERIFIED_UID = 'f7-unverified-uid'; // ケース5: google.com だが未検証（リンクしない）

// Bearer 文字列 → 検証済みクレーム。ケースごとに provider/検証状態/メールを変える。
// 大文字小文字非依存を実証するため、ケース3 のメールは保留行（linkme@example.com）に対し
// 混在ケース（LinkMe@Example.com）で与える。
const TOKENS: Record<string, VerifiedToken> = {
  [OP_TOKEN]: { uid: OP_TOKEN, email: 'op@example.com', emailVerified: true, signInProvider: 'google.com' },
  [DISABLED_TOKEN]: {
    uid: DISABLED_TOKEN,
    email: 'disabled@example.com',
    emailVerified: true,
    signInProvider: 'google.com',
  },
  [LINK_NEW_UID]: {
    uid: LINK_NEW_UID,
    email: 'LinkMe@Example.com',
    emailVerified: true,
    signInProvider: 'google.com',
  },
  [NOPASS_UID]: {
    uid: NOPASS_UID,
    email: 'nopass@example.com',
    emailVerified: true,
    signInProvider: 'password',
  },
  [UNVERIFIED_UID]: {
    uid: UNVERIFIED_UID,
    email: 'unverified@example.com',
    emailVerified: false,
    signInProvider: 'google.com',
  },
};

let config: DashboardApiConfig;
// beforeAll でシードした保留・無効化利用者の id（DB アサーションを fixture スコープに閉じる）。
let nopassUserId: string;
let unverifiedUserId: string;

// firebase-admin を隔離した TokenVerifier のモック。Bearer 文字列を TOKENS で引き、
// 未登録文字列は「未検証・provider 無し」既定（＝リンク不可）にフォールバックする。
const verifier: TokenVerifier = {
  verifyIdToken: (t) =>
    Promise.resolve(TOKENS[t] ?? { uid: t, email: null, emailVerified: false, signInProvider: null }),
};

function buildApp(): ReturnType<typeof createApp> {
  // 本番と同じ合成根（src/composition.ts）を呼び、verifier だけを差し替える。構造化ログは捨てる。
  return createApp(buildAppDeps({ config, verifier, structuredLog: () => undefined }));
}

async function get(app: ReturnType<typeof createApp>, bearer: string, path: string): Promise<Response> {
  return await app.request(path, { headers: { Authorization: `Bearer ${bearer}` } });
}

async function post(
  app: ReturnType<typeof createApp>,
  bearer: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// fixture スコープに閉じた DB 観測ヘルパ（auth_subject の実値を裏付ける）。
async function authSubjectOf(userId: string): Promise<string | null> {
  const res = await (
    await getPool()
  ).query<{ auth_subject: string | null }>(
    'SELECT auth_subject FROM dashboard_users WHERE id = $1',
    [userId],
  );
  return res.rows[0]?.auth_subject ?? null;
}

describe.skipIf(!process.env.DATABASE_URL)(
  '招待コードのクロス spec 整合と初回ログイン時リンクの統合検証 (DB)',
  () => {
    beforeAll(async () => {
      config = loadConfig({
        SURVEY_BASE_URL: 'https://survey.example',
        DASHBOARD_WEB_ORIGIN: 'https://dash.example',
        PLACES_API_KEY: 'test-places-key',
      });
      const pool = await getPool();
      await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP1, 'f7運営']);
      await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
        AG_A,
        OP1,
        'f7代理店A',
      ]);
      // operator 利用者（招待コード発行・保留利用者作成の主体。auth_subject は設定済み）。
      await pool.query(
        `INSERT INTO dashboard_users (role, operator_id, agency_id, auth_subject, display_name)
         VALUES ('operator', $1, NULL, $2, 'f7運営スタッフ')`,
        [OP1, OP_TOKEN],
      );
      // ケース4・5 の保留利用者（auth_subject NULL）。createPendingDashboardUser 経由（案B の事前登録）。
      const nopass = await createPendingDashboardUser(pool, {
        role: 'agency',
        operatorId: OP1,
        agencyId: AG_A,
        email: 'nopass@example.com',
      });
      if (nopass.kind !== 'created') throw new Error('フィクスチャの保留利用者を作れません');
      nopassUserId = nopass.user.id;
      const unverified = await createPendingDashboardUser(pool, {
        role: 'agency',
        operatorId: OP1,
        agencyId: AG_A,
        email: 'unverified@example.com',
      });
      if (unverified.kind !== 'created') throw new Error('フィクスチャの保留利用者を作れません');
      unverifiedUserId = unverified.user.id;
      // ケース6 の無効化済み利用者（auth_subject は既にリンク済み ＋ disabled_at 設定済み）。
      await pool.query(
        `INSERT INTO dashboard_users (role, operator_id, agency_id, auth_subject, email, display_name, disabled_at)
         VALUES ('agency', $1, $2, $3, 'disabled@example.com', 'f7無効化スタッフ', now())`,
        [OP1, AG_A, DISABLED_TOKEN],
      );
    });

    afterAll(async () => {
      await closePool();
    });

    // === A. 招待コードのクロス spec 整合（Req 5.2, 5.3）===

    it('運営が発行した招待コードは LINE 解決経路で使え、無効化すると解決しなくなる', async () => {
      const app = buildApp();
      const pool = await getPool();

      // (1) 運営が代理店A のコードを発行（Req 5.2）。
      const issued = await post(app, OP_TOKEN, '/invite-codes', { agencyId: AG_A });
      expect(issued.status).toBe(201);
      const { inviteCode } = (await issued.json()) as {
        inviteCode: { id: string; code: string; agencyId: string };
      };
      expect(inviteCode.agencyId).toBe(AG_A);

      // ダッシュボード発行コードが LINE オンボーディングの解決経路で使える
      // （findActiveInviteCode が同一代理店を返す）。これがクロス spec の使用可能性を実証する。
      const resolved = await findActiveInviteCode(pool, inviteCode.code);
      expect(resolved).toEqual({ agencyId: AG_A });

      // (2) 無効化（Req 5.3）。operator は対象代理店の明示指定が必要。
      const disabled = await post(app, OP_TOKEN, `/invite-codes/${inviteCode.id}/disable`, {
        agencyId: AG_A,
      });
      expect(disabled.status).toBe(200);

      // 無効化後は LINE 解決経路で使えない（以後のオーナー紐付け不可・Req 5.3）。
      const afterDisable = await findActiveInviteCode(pool, inviteCode.code);
      expect(afterDisable).toBeNull();
    });

    // === B. 初回ログイン時リンク（Req 1.2, 6.2, 6.4）===

    it('検証済み Google 初回ログインが保留行へ大小無視でリンクし、以後は安定して解決する', async () => {
      const app = buildApp();

      // 運営が保留利用者を事前登録（案B・auth_subject NULL）。POST /dashboard-users を用いた END-TO-END。
      const created = await post(app, OP_TOKEN, '/dashboard-users', {
        role: 'agency',
        agencyId: AG_A,
        email: 'linkme@example.com',
      });
      expect(created.status).toBe(201);
      const { user: pending } = (await created.json()) as { user: { id: string } };
      // 事前登録直後はまだリンクされていない（auth_subject NULL）。
      expect(await authSubjectOf(pending.id)).toBeNull();

      // 新規 Google ログイン（大文字混在メール LinkMe@Example.com・emailVerified true・google.com）。
      const first = await get(app, LINK_NEW_UID, '/me');
      expect(first.status).toBe(200);
      const { user: me } = (await first.json()) as {
        user: { role: string; agencyId: string | null };
      };
      expect(me.role).toBe('agency');
      expect(me.agencyId).toBe(AG_A);

      // リンクが DB に確定している: 保留行の auth_subject が UID で埋まっている（lower(email) 照合・Req 1.2, 6.2）。
      expect(await authSubjectOf(pending.id)).toBe(LINK_NEW_UID);

      // 2 回目の GET /me も 200（findByAuthSubject が UID で直接解決・再リンク不要で安定）。
      const second = await get(app, LINK_NEW_UID, '/me');
      expect(second.status).toBe(200);
      // 2 回目でも auth_subject は不変（二重リンクや上書きが起きない）。
      expect(await authSubjectOf(pending.id)).toBe(LINK_NEW_UID);
    });

    it('非 Google（password）ログインは保留行にリンクせず 403・auth_subject は NULL のまま（乗っ取り防止）', async () => {
      const app = buildApp();
      const res = await get(app, NOPASS_UID, '/me');
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string }; user?: unknown };
      expect(body.error.code).toBe('forbidden');
      expect(body.user).toBeUndefined(); // 管理情報は一切返さない（Req 1.3 の同一封筒）。

      // 検証済みでも provider が google.com でないためリンクを試行しない（auth_subject 不変）。
      expect(await authSubjectOf(nopassUserId)).toBeNull();
    });

    it('Google だがメール未検証のログインは保留行にリンクせず 403・auth_subject は NULL のまま（乗っ取り防止）', async () => {
      const app = buildApp();
      const res = await get(app, UNVERIFIED_UID, '/me');
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string }; user?: unknown };
      expect(body.error.code).toBe('forbidden');
      expect(body.user).toBeUndefined();

      // email_verified が false のためリンクを試行しない（auth_subject 不変）。
      expect(await authSubjectOf(unverifiedUserId)).toBeNull();
    });

    it('無効化済み利用者は自身の UID でログインしても 403・管理情報を返さない（Req 6.4）', async () => {
      const app = buildApp();
      const res = await get(app, DISABLED_TOKEN, '/me');
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string }; user?: unknown };
      expect(body.error.code).toBe('forbidden');
      expect(body.user).toBeUndefined(); // 無効化後はログインを拒否（管理情報なし）。
    });
  },
);

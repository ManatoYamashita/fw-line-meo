import type {
  AuditLogger,
  SetStoreSuspensionInput,
  SetStoreSuspensionOutcome,
  SuspensionDirection,
} from '@fwlm/db';
import { authenticate, type AuthDeps } from './auth.js';
import { resolveAgencyScope } from './scope.js';
import { jsonError } from './http.js';

// POST /stores/:id/suspend・POST /stores/:id/resume の中核ロジック（store-suspension・Issue #252。
// Req 1.1–1.5, 7.1–7.3）。1 つのハンドラが向き（direction）を受けて両ルートを担う。
// 範囲は利用者の役割だけから決め、要求のボディは受け取らない（運営が代理店を指定する必要が無い）。
// 範囲の判定と状態の更新は DAL（setStoreSuspension）の 1 文で行われ、範囲外と不存在は
// どちらも not_found として返る。本ハンドラはそれを同じ本文の 404 に写像し、存在を明かさない。

/** 停止状態の JSON 形。Date は ISO 8601 文字列へ明示的に変換する。 */
export interface StoreSuspensionJson {
  id: string;
  /** ISO 8601。利用中は null。 */
  suspendedAt: string | null;
}

export interface StoreSuspensionDeps {
  auth: AuthDeps;
  // setStoreSuspension（@fwlm/db）を部分適用した切り替え。
  setSuspension: (input: SetStoreSuspensionInput) => Promise<SetStoreSuspensionOutcome>;
  auditLog?: AuditLogger;
}

export interface StoreSuspensionRequest {
  authorization: string | undefined;
  // パスパラメータ :id（UUID 形式を事前検証する）。
  id: string;
  direction: SuspensionDirection;
}

// UUID 形式でない id は DB を叩かず 404 扱い（存在の探り当てを許さない・invite-codes と同じ規律）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 監査の action は向きから一意に決まる。
const AUDIT_ACTION = {
  suspend: 'store_suspended',
  resume: 'store_resumed',
} as const satisfies Record<SuspensionDirection, string>;

export async function handleStoreSuspension(
  deps: StoreSuspensionDeps,
  req: StoreSuspensionRequest,
): Promise<Response> {
  // 1. 認証。未登録・無効化は同一の 403 封筒（存在有無を漏らさない）。
  const auth = await authenticate(deps.auth, req.authorization);
  if (auth.kind === 'unauthenticated') {
    return jsonError(401, 'unauthenticated', 'ログインが必要です');
  }
  if (auth.kind === 'unregistered' || auth.kind === 'disabled') {
    return jsonError(403, 'forbidden', 'アクセス権がありません');
  }
  const user = auth.user;

  // 2. UUID 事前ガード（DAL に到達させない）。不正形式は不在と同じ 404（存在の秘匿）。
  if (!UUID_RE.test(req.id)) return notFound();

  // 3. 範囲の決定。運営は全店舗（null）、代理店は自代理店に束縛する。
  //    代理店の所属が欠けている場合（構造上あり得ない）は防御的に 403 とする。
  const scope = resolveAgencyScope(user, undefined);
  if (!scope.ok) return jsonError(403, 'forbidden', 'アクセス権がありません');
  const agencyId = scope.scope.kind === 'all' ? null : scope.scope.agencyId;

  // 4. 範囲つきの切り替え。範囲外と不存在はどちらも not_found（同じ本文の 404）。
  const outcome = await deps.setSuspension({ storeId: req.id, direction: req.direction, agencyId });
  if (outcome.kind === 'not_found') return notFound();

  // 5. 状態が変わったときだけ、コミット後に監査を記録する（変化なしは記録しない・7.3）。
  //    対象 ID は要求の表記ではなく DB が返した正規表記を使う。監査の失敗は捕捉しない
  //    （既存の無効化系と同じ扱い。5xx になるが停止・再開そのものは成立している）。
  if (outcome.kind === 'changed') {
    await deps.auditLog?.({
      actorType: user.role,
      actorId: user.id,
      action: AUDIT_ACTION[req.direction],
      targetType: 'store',
      targetId: outcome.store.id,
    });
  }

  // 6. 変化の有無によらず 200（既に目的の状態にある要求は成功として扱う・1.5）。
  const store: StoreSuspensionJson = {
    id: outcome.store.id,
    suspendedAt: outcome.store.suspendedAt === null ? null : outcome.store.suspendedAt.toISOString(),
  };
  return new Response(JSON.stringify({ store }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notFound(): Response {
  return jsonError(404, 'not_found', '店舗が見つかりません');
}

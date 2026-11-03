import type { AuditLogger, UnlinkOwnerLineInput, UnlinkOwnerLineOutcome } from '@fwlm/db';
import type { LogFields, Sink } from '@fwlm/observability';
import { authenticate, type AuthDeps } from './auth.js';
import { resolveAgencyScope } from './scope.js';
import { jsonError } from './http.js';
import { recordAudit } from './audit.js';
import type { LineRichMenuAdapter } from './line-richmenu.js';

// POST /owners/:id/unlink の中核ロジック（owner-line-unlink・Issue #487。Req 1.1–1.3, 1.5, 1.7,
// 3.1–3.4, 7.1, 7.3）。解除と、メニューの外し直しを 1 つのルートで受ける。
//
// 手順: 認証 → UUID の事前ガード → 範囲の決定 → 解除（DAL）→ 変化したときだけ監査 →
// メニュー操作の対象があれば LINE の個別リンクを外す → 外せたら未解除の印を消す → 応答。
//
// - 範囲は利用者の役割だけから決め、要求のボディは受け取らない（store-suspension と同じ）。
//   範囲の判定と施錠は DAL（unlinkOwnerLine）の 1 トランザクションで行われ、範囲外と不存在は
//   どちらも not_found として返る。本ハンドラはそれを同じ本文の 404 に写像し、存在を明かさない（1.3）。
// - DB の確定と LINE の呼び出しは別の段階である。LINE が失敗しても解除は取り消さず、
//   menu: 'failed' と未解除の印で表す（3.2）。既に解除済みで印が残っているオーナーへの要求は、
//   状態を変えずに LINE を呼び直す。これが外し直しの操作である（1.5, 3.4）。
// - 解除の DB の失敗は例外のまま返す。DAL がロールバックしているので紐づけは解除前のままであり、
//   ルート（Hono）が 500 にする（1.7）。
// - LINE ユーザー ID は応答・記録・監査のいずれにも出さない（design.md「Security Considerations」）。
//
// 解除の確定から LINE を呼ぶまでの間に、元の LINE アカウントが招待コードから再登録して完了後メニューまで
// 張り終えると、新しいオーナーのメニューを外しうる。DAL は施錠したトランザクションの中で「元の ID を別の
// 連携中オーナーが持つか」を確かめて対象から外しているので、残る窓はトークン発行と DELETE の数秒だけである。
// 再登録から完了後メニューのリンクまでには招待コードの入力と店舗の確定が要り、この窓に収まらない。
// それでも外れた場合、新しいオーナーには既定のメニューが表示される。振り分け口（line-webhook の
// owner/router.ts）は友だち追加（ブロックの解除を含む）と再開の postback で完了後メニューを張り直す。

/** メニューの結果。外した・外せなかった・外す対象が無かった。 */
export type MenuUnlinkResult = 'removed' | 'failed' | 'not_needed';

/** 応答の形（design.md「OwnerLineUnlinkHandler」の API Contract）。 */
export interface OwnerLineUnlinkResponse {
  owner: { id: string; lineLink: 'unlinked'; menuUnlinkPending: boolean };
  menu: MenuUnlinkResult;
}

export interface OwnerLineUnlinkDeps {
  auth: AuthDeps;
  // unlinkOwnerLine（@fwlm/db）を部分適用した解除。範囲外・不存在はどちらも not_found。
  unlinkOwnerLine: (input: UnlinkOwnerLineInput) => Promise<UnlinkOwnerLineOutcome>;
  // clearOwnerMenuPending（@fwlm/db）を部分適用した、未解除の印の消去。
  clearMenuPending: (input: { ownerId: string; lineUserId: string }) => Promise<void>;
  // 個別リッチメニューのリンクを外すだけの LINE アダプタ（line-richmenu.ts）。
  lineRichMenu: LineRichMenuAdapter;
  // 必須（Issue #275）。省略可能だと合成根で配線を落としても型検査が通る。
  auditLog: AuditLogger;
}

export interface OwnerLineUnlinkRequest {
  authorization: string | undefined;
  // パスパラメータ :id（UUID 形式を事前検証する）。
  id: string;
  log?: Sink;
}

// UUID 形式でない id は DB を叩かず 404 扱い（存在の探り当てを許さない・store-suspension と同じ規律）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleOwnerLineUnlink(
  deps: OwnerLineUnlinkDeps,
  req: OwnerLineUnlinkRequest,
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

  // 3. 範囲の決定。運営は全オーナー（null）、代理店は自代理店に束縛する。
  //    代理店の所属が欠けている場合（構造上あり得ない）は防御的に 403 とする。
  const scope = resolveAgencyScope(user, undefined);
  if (!scope.ok) return jsonError(403, 'forbidden', 'アクセス権がありません');
  const agencyId = scope.scope.kind === 'all' ? null : scope.scope.agencyId;

  // 4. 範囲つきの解除。範囲外と不存在はどちらも not_found（同じ本文の 404）。
  const outcome = await deps.unlinkOwnerLine({ ownerId: req.id, agencyId });
  if (outcome.kind === 'not_found') return notFound();

  // 5. 状態が変わったときだけ、コミット後に監査を記録する（外し直し・二重の解除は記録しない・7.3）。
  //    対象 ID は要求の表記ではなく DB が返した正規表記を使う。監査の失敗は警告を残して握り、
  //    成立している解除をエラー応答にしない（Issue #250）。
  if (outcome.kind === 'changed') {
    await recordAudit(deps.auditLog, req.log, {
      actorType: user.role,
      actorId: user.id,
      action: 'owner_line_unlinked',
      targetType: 'owner',
      targetId: outcome.ownerId,
    });
  }

  // 6. メニューの個別リンクを外す（3.1, 3.4）。対象が無ければ LINE を呼ばない。
  const menu =
    outcome.menuTarget === null
      ? 'not_needed'
      : await unlinkMenu(deps, req.log, { ownerId: outcome.ownerId, lineUserId: outcome.menuTarget });

  // 7. 変化の有無によらず 200（既に解除済みへの要求は成功として扱う・1.5）。
  const body: OwnerLineUnlinkResponse = {
    owner: { id: outcome.ownerId, lineLink: 'unlinked', menuUnlinkPending: menu === 'failed' },
    menu,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * LINE の個別リンクを外し、外せたら未解除の印を消す。成否を事象として記録する（Issue #228 に倣い、
 * 成功も失敗も記録する）。例外を投げない。
 *
 * 記録の項目は種別（errorKind）と状態コード（status）だけで、LINE ユーザー ID・応答本文は載せない。
 * LINE では外せたが印を消せなかったときも、画面に外し直しの操作を残すため failed とし、
 * 種別 pending_clear_failed で記録する（印が残っていれば外し直しで LINE を呼び直し、2xx か 404 で終わる）。
 */
async function unlinkMenu(
  deps: OwnerLineUnlinkDeps,
  log: Sink | undefined,
  target: { ownerId: string; lineUserId: string },
): Promise<'removed' | 'failed'> {
  const result = await deps.lineRichMenu.unlinkUserRichMenu(target.lineUserId);
  if (!result.ok) {
    const fields: LogFields =
      result.httpStatus === null
        ? { errorKind: result.errorKind }
        : { errorKind: result.errorKind, status: result.httpStatus };
    log?.('warn', 'dashboard-api.richmenu_unlink_failed', fields);
    return 'failed';
  }

  try {
    await deps.clearMenuPending(target);
  } catch {
    // swallowed-exception: intentional — 解除は確定済みで、LINE のリンクも外れている。印が残るだけなので
    // 応答は 200 の failed とし、画面の外し直しで回復させる。失敗は種別つきで記録する。
    // 例外の文言は捨てる（接続情報や入力値が混ざりうるため）。
    log?.('warn', 'dashboard-api.richmenu_unlink_failed', { errorKind: 'pending_clear_failed' });
    return 'failed';
  }

  log?.('info', 'dashboard-api.richmenu_unlinked');
  return 'removed';
}

function notFound(): Response {
  return jsonError(404, 'not_found', 'オーナーが見つかりません');
}

// 完了後リッチメニューのリンクと、その成否の記録（line-on-demand-report tasks 3.10 で 1 か所に寄せた）。
//
// 完了後メニューを張る経路は 2 つある。どちらもこのモジュールの関数を使い、同じ事象と監査記録を残す。
// - オンボーディングの完了時（onboarding/conversation.ts の handleConfirm）
// - 店舗特定済みオーナーの振り分け口のメニュー照合（owner/router.ts）
//
// 置き場所: 会話（onboarding/conversation.ts）は振り分け口（owner/router.ts）を import し、振り分け口は会話の型を
// import する。どちらかにこの処理を置くと、もう一方から値を import することになり、2 つのモジュールが互いに値を
// import し合う。このモジュールは LINE の Messenger の型と @fwlm/db・@fwlm/observability の型だけに依存し、会話にも
// 振り分け口にも依存しないので、両方から循環なく import できる。
//
// 記録（ログ）には店舗 ID と LINE ユーザー ID を載せない。載せるのは例外の種別だけである。

import type { AuditLogInput, AuditLogger } from '@fwlm/db';
import type { LogFields } from '@fwlm/observability';
import type { LineMessenger } from '../line/client.js';

/**
 * 記録の手段。onboarding/conversation.ts の ConversationLogger と同じ形で、そちらをそのまま渡せる
 * （会話への依存を作らないため、ここでは形だけを宣言する）。
 */
export interface CompletedMenuLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

export interface CompletedMenuDeps {
  readonly messenger: Pick<LineMessenger, 'linkRichMenu'>;
  readonly logger: CompletedMenuLogger;
  /** 業務書込の監査記録。顧客識別子ではなく owners.id のみを渡す。 */
  readonly auditLog?: AuditLogger | undefined;
  /** 完了後リッチメニューの ID（env LINE_RICHMENU_COMPLETED_ID）。 */
  readonly lineRichMenuCompletedId: string;
}

/** 例外の種別だけを取り出す。本文は記録しない（接続情報や入力値が混ざりうるため）。 */
export function errorKindOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'UnknownError';
}

/** 監査記録の障害は業務処理を巻き戻さず、正典の事象へ警告を残す。 */
export async function tryAuditLog(
  deps: Pick<CompletedMenuDeps, 'logger' | 'auditLog'>,
  input: AuditLogInput,
): Promise<void> {
  if (!deps.auditLog) return;
  try {
    await deps.auditLog(input);
  } catch (err) {
    deps.logger.warn('line-webhook.audit_log_failed', { errorKind: errorKindOf(err) });
  }
}

/**
 * 完了後メニューをオーナーへ張り、成否を事象（line-webhook.richmenu_linked／richmenu_link_failed）と監査記録
 * （rich_menu_linked／rich_menu_link_failed）に残す。張れたら true を返す。**例外を投げない。**
 *
 * 呼出元はどちらも Reply を送った後に呼ぶ。投げると、エラー境界（app.ts）が使用済みの replyToken で 2 回目の
 * Reply を試みる。リンクの失敗は巻き戻すトランザクションも無いので、記録だけを残して戻る。
 *
 * **成功も失敗も記録する**（Issue #228 タスク 4）。失敗だけを記録すると「記録が無い」が成功と未実行のどちらを
 * 意味するか判定できない。DB の行は成否の証拠にならない（infra/README.md が「実際に切り替わったか」を意味しないと
 * 記録している）。
 *
 * **記録は業務処理（リンク）の外側で行う。** 同じ try の中へ入れると、記録の手段が投げたときに catch が走り、
 * 成功したリンクに対して失敗が記録される。成否を先に確定させ、記録は別の try で包む。
 */
export async function linkCompletedMenu(deps: CompletedMenuDeps, lineUserId: string, ownerId: string): Promise<boolean> {
  let linked = false;
  let linkError: unknown;
  try {
    await deps.messenger.linkRichMenu(lineUserId, deps.lineRichMenuCompletedId);
    linked = true;
  } catch (err) {
    // 張れなかったことは下で記録する。応答は済んでいるので、ここで投げない。
    linkError = err;
  }

  try {
    if (linked) {
      deps.logger.info('line-webhook.richmenu_linked');
      await tryAuditLog(deps, {
        actorType: 'owner',
        actorId: ownerId,
        action: 'rich_menu_linked',
        targetType: 'owner',
        targetId: ownerId,
      });
    } else {
      deps.logger.warn('line-webhook.richmenu_link_failed', { errorKind: errorKindOf(linkError) });
      await tryAuditLog(deps, {
        actorType: 'owner',
        actorId: ownerId,
        action: 'rich_menu_link_failed',
        targetType: 'owner',
        targetId: ownerId,
      });
    }
  } catch {
    // swallowed-exception: intentional — 記録の手段自身の失敗を業務処理へ伝えない。Reply は済んでおり、
    // 投げるとエラー境界が 2 回目の Reply を試みる。記録できないことを理由に、利用者に見える振る舞いを変えない。
  }
  return linked;
}

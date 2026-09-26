// 店舗特定済みオーナーの振り分け口（design.md「StoreIdentifiedOwnerRouter」「店舗特定済みオーナーの振り分け」・
// line-on-demand-report Requirements 2.3, 2.5, 2.6, 2.8, 2.9）。
//
// 店舗特定済みのオーナー（owners.onboarding_status = 'store_identified'）から届いたイベントを、会話の段階を問わず受ける。
// - postback のうちレポートの data は、レポートへ渡す（2.3）
// - それ以外の postback（再開・候補の選択・確定・やり直し・古い形・壊れた形）、テキスト（「ステータス確認」を含む）、
//   スタンプなど、友だち追加には、ステータス案内を返す（2.5）。オンボーディングの案内は返さない（2.9）
// 第2フェーズ（gbp-post-review-reply・Issue #323）は、ここで GBP の会話へ渡す。既存の分岐と応答は変えない（2.7）。
// - GBP の postback（data が g_ で始まる）は GBP の会話へ渡す
// - テキストは、GBP の手続きが進行中のとき（gbp_sessions に有効な行があるとき）だけ GBP の会話が引き受ける
// - GBP の会話が引き受けなかったもの（not_handled・GBP の障害を握った場合を含む）は、下の既存の分岐へ落ちる
// - GBP が既定 OFF（gbp が無い）ときは、この分岐を一切通らない。gbp_sessions も読まない
//
// Reply の後、次のいずれかに当たれば完了後メニューを張る（2.6・2.8）。
// 1. 会話の段階が completed でない。代理店が店舗を登録したオーナーは、段階が途中のまま店舗特定済みになる
// 2. 友だち追加（ブロックの解除を含む）。旧メニューの削除で既定の面へ落ちている可能性がある
// 3. 再開の postback。オンボーディング用メニューにしか無い導線なので、送った時点でそのメニューを見ている
// 1 のときは、張れた場合に限り段階を completed に揃える。onboarding_sessions.stage を「完了後メニューを張ったか」の
// 目印に使うためで、張れなければ段階を変えず、次の操作で再び張る。リンクは冪等で、2 回張っても結果は同じである。
//
// 例外の扱い:
// - Reply を送る前の例外（セッションの読み出し・ステータス案内の Reply・レポートの例外）は、そのまま投げる。
//   レポートの StoreScopedReportError も包み直さない。エラー境界（app.ts）が再試行案内を 1 回だけ返す。
//   このときメニューの照合はしない（次の操作で照合する）
// - Reply の後の失敗（リンク・段階の更新・記録）は投げない。応答は済んでおり、投げるとエラー境界が 2 回目の Reply を試みる
//
// 記録（ログ）には店舗 ID と LINE ユーザー ID を載せない。リンクとその成否の記録は、オンボーディング完了時の
// リンク（onboarding/conversation.ts）と同じ関数（owner/completed-menu.ts）で行う。
//
// ReportHandler はロガーを作成時に固定する。相関 ID をリクエストごとに記録へ残すため、ReportHandler とこの router は
// リクエストごとに、そのリクエストのロガーと Messenger で作る（どちらも作成は軽い）。そのための作り方が
// createStoreIdentifiedOwnerRouterFactory で、合成ルート（index.ts）が設定の値で 1 度だけ作り、会話
// （onboarding/conversation.ts）がイベントごとに呼ぶ。

import type { AuditLogger, OwnerRow, Queryable } from '@fwlm/db';
import { decodeReportPostback } from '@fwlm/line-report';
import type { LineMessenger } from '../line/client.js';
import { buildStatusGuidanceMessage } from '../line/messages.js';
import type { ConversationLogger, SessionsAccessor } from '../onboarding/conversation.js';
import { decodePostback } from '../onboarding/stages.js';
import type { GbpFlowHandlers } from '../gbp/flows.js';
import { isGbpPostbackData } from '../gbp/postback.js';
import { createReportHandler, type ReportHandler, type ReportReadsAccessor } from '../report/handler.js';
import type { InboundEvent } from '../webhook/dispatch.js';
import { errorKindOf, linkCompletedMenu } from './completed-menu.js';

export interface StoreIdentifiedOwnerRouterDeps {
  readonly db: Queryable;
  readonly sessions: SessionsAccessor;
  readonly messenger: LineMessenger;
  readonly reports: ReportHandler;
  readonly logger: ConversationLogger;
  /** 業務書込の監査記録。顧客識別子ではなく owners.id のみを渡す。 */
  readonly auditLog?: AuditLogger;
  /** 完了後リッチメニューの ID（env LINE_RICHMENU_COMPLETED_ID）。オンボーディング完了時のリンクと同じものを張る。 */
  readonly lineRichMenuCompletedId: string;
  /** GBP の会話（gbp-post-review-reply）。既定 OFF のときは無い（Issue #323）。 */
  readonly gbp?: GbpFlowHandlers;
}

export interface StoreIdentifiedOwnerRouter {
  /**
   * 店舗特定済みのオーナーのイベントを 1 つ処理する。owner は、event の LINE ユーザーから引いた店舗特定済みの
   * オーナーに限る。例外を投げるときは Reply を送っていない。
   */
  handleEvent(event: InboundEvent, owner: OwnerRow): Promise<void>;
}

/**
 * 店舗特定済みのオーナーか。確定店舗を作るのは confirmStore だけで、同じトランザクションでオーナーを
 * store_identified にするので、「確定店舗を 1 店以上持つ」と同値である（代理店による登録の経路も含む）。
 */
export function isStoreIdentified(owner: OwnerRow | null): owner is OwnerRow {
  return owner !== null && owner.onboarding_status === 'store_identified';
}

/** 再開の postback か。オンボーディングの復号で読む（この復号はレポートの data を受理しない）。 */
function isResumePostback(event: InboundEvent): boolean {
  return event.kind === 'postback' && decodePostback(event.data)?.kind === 'resume';
}

/** Reply の後の処理の成否。例外を値にして持ち、記録を業務処理の外側で行う。 */
/**
 * GBP の会話へ渡す。引き受けて Reply まで済ませたときだけ true を返す。GBP の postback でもテキストでもない
 * イベント（友だち追加・スタンプ・レポートの postback など）は渡さない。
 */
async function delegateToGbp(gbp: GbpFlowHandlers, event: InboundEvent, ownerId: string): Promise<boolean> {
  if (event.kind === 'postback' && isGbpPostbackData(event.data)) {
    const outcome = await gbp.handleGbpPostback({
      ownerId,
      lineUserId: event.lineUserId,
      replyToken: event.replyToken,
      data: event.data,
    });
    return outcome === 'handled';
  }
  if (event.kind === 'text') {
    const outcome = await gbp.handleGbpText({
      ownerId,
      lineUserId: event.lineUserId,
      replyToken: event.replyToken,
      text: event.text,
    });
    return outcome === 'handled';
  }
  return false;
}

type Attempt = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

async function attempt(run: () => Promise<void>): Promise<Attempt> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function createStoreIdentifiedOwnerRouter(deps: StoreIdentifiedOwnerRouterDeps): StoreIdentifiedOwnerRouter {
  /**
   * 完了後メニューを張り、markCompleted なら張れた場合に限り段階を completed に揃える。例外を投げない。
   * リンクとその成否の記録は owner/completed-menu.ts が行う。段階の更新とその失敗の記録は、リンクの後にここで行う。
   *
   * 記録は業務処理（段階の更新）の外側で行う。同じ try の中へ入れると、記録の手段が投げたときに、成功した更新に
   * 対して失敗が記録される（completed-menu.ts のリンクと同じ理由）。
   */
  async function reconcileCompletedMenu(lineUserId: string, ownerId: string, markCompleted: boolean): Promise<void> {
    const linked = await linkCompletedMenu(deps, lineUserId, ownerId);
    if (!linked || !markCompleted) return;

    // ownerId も同じ更新で渡す。await_invite_code のまま（owner_id が NULL）の行でも、
    // ck_session_owner_stage（stage = await_invite_code ⇔ owner_id IS NULL）を満たすため。
    const stage = await attempt(() =>
      deps.sessions.updateSession(deps.db, lineUserId, { stage: 'completed', ownerId }),
    );
    if (stage.ok) return;
    try {
      deps.logger.warn('line-webhook.session_stage_update_failed', { errorKind: errorKindOf(stage.error) });
    } catch {
      // swallowed-exception: intentional — 記録の手段自身の失敗を業務処理へ伝えない。Reply は済んでおり、
      // 投げるとエラー境界が 2 回目の Reply を試みる。記録できないことを理由に、利用者に見える振る舞いを変えない。
    }
  }

  return {
    async handleEvent(event: InboundEvent, owner: OwnerRow): Promise<void> {
      if (!isStoreIdentified(owner) || owner.line_user_id !== event.lineUserId) {
        // 呼出元の誤り。店舗特定済みでない人へ完了後メニューを張らない（2.6）ため、何も送らず・張らずに投げる。
        throw new Error('StoreIdentifiedOwnerRouter: owner must be the store-identified owner of the event');
      }

      // 段階は Reply の前に読む。Reply の後に読むと、読み出しの失敗を Reply の後に投げることになる。
      const session = await deps.sessions.getOrCreateSession(deps.db, event.lineUserId);

      const handledByGbp = deps.gbp !== undefined && (await delegateToGbp(deps.gbp, event, owner.id));
      if (!handledByGbp) {
        const request = event.kind === 'postback' ? decodeReportPostback(event.data) : null;
        if (request !== null) {
          await deps.reports.handle({ replyToken: event.replyToken, ownerId: owner.id, request });
        } else {
          await deps.messenger.reply(event.replyToken, [buildStatusGuidanceMessage()]);
        }
      }

      const stageCompleted = session.stage === 'completed';
      if (stageCompleted && event.kind !== 'follow' && !isResumePostback(event)) {
        return;
      }
      await reconcileCompletedMenu(event.lineUserId, owner.id, !stageCompleted);
    },
  };
}

/** リクエストごとに変わる依存。そのリクエストのロガー（相関 ID つき）と、そのロガーを適用した Messenger。 */
export interface StoreIdentifiedOwnerRouterScope {
  readonly logger: ConversationLogger;
  readonly messenger: LineMessenger;
}

/** リクエストごとに router を作る。会話（onboarding/conversation.ts）がイベントごとに呼ぶ。 */
export type StoreIdentifiedOwnerRouterFactory = (scope: StoreIdentifiedOwnerRouterScope) => StoreIdentifiedOwnerRouter;

/** リクエストをまたいで変わらない依存。合成ルートが設定の値で渡す。 */
export interface StoreIdentifiedOwnerRouterFactoryDeps {
  readonly db: Queryable;
  readonly sessions: SessionsAccessor;
  /** 業務書込の監査記録。顧客識別子ではなく owners.id のみを渡す。 */
  readonly auditLog?: AuditLogger;
  /** 完了後リッチメニューの ID（env LINE_RICHMENU_COMPLETED_ID）。 */
  readonly lineRichMenuCompletedId: string;
  /** 詳細画面の LIFF URL（env LIFF_STORE_DETAIL_URL）。推移のレポートの導線に使う。 */
  readonly liffStoreDetailUrl: string;
  /** レポートの読み出し。省略すると @fwlm/db の関数を使う（試験で偽物に差し替える）。 */
  readonly reads?: ReportReadsAccessor;
  /** 現在時刻。省略すると実行時の時刻を使う（試験で固定する）。 */
  readonly now?: () => Date;
  /** GBP の会話（gbp-post-review-reply）。既定 OFF のときは渡さない（Issue #323）。 */
  readonly gbp?: GbpFlowHandlers;
}

/**
 * ReportHandler とこの router を、呼ばれるたびに新しく作る作り方を返す。作ったものを使い回さない
 * （使い回すと、2 つ目以降のリクエストの記録と Reply が、最初に作ったときのロガーと Messenger へ流れる）。
 */
export function createStoreIdentifiedOwnerRouterFactory(
  deps: StoreIdentifiedOwnerRouterFactoryDeps,
): StoreIdentifiedOwnerRouterFactory {
  return ({ logger, messenger }) =>
    createStoreIdentifiedOwnerRouter({
      db: deps.db,
      sessions: deps.sessions,
      messenger,
      logger,
      ...(deps.auditLog ? { auditLog: deps.auditLog } : {}),
      lineRichMenuCompletedId: deps.lineRichMenuCompletedId,
      ...(deps.gbp ? { gbp: deps.gbp } : {}),
      reports: createReportHandler({
        db: deps.db,
        messenger,
        liffStoreDetailUrl: deps.liffStoreDetailUrl,
        logger,
        ...(deps.reads ? { reads: deps.reads } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      }),
    });
}

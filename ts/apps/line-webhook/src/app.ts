import { Hono } from 'hono';
import { createEventDispatcher, type InboundEvent } from './webhook/dispatch.js';
import type { SignatureVerifier } from './webhook/signature.js';
import type { ConversationHandlers } from './onboarding/conversation.js';
import type { LineMessenger } from './line/client.js';
import { buildInternalErrorRetryMessage } from './line/messages.js';

// 構造化ログの最小契約（design.md「Monitoring」: LINE はログを提供しないため自前で記録する）。
// オーナーの自由入力テキストや displayName は本境界では扱わない（渡していない）ため、
// ここでの meta にそれらが混入する余地は構造的にない。
export interface AppLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface AppDeps {
  signatureVerifier: SignatureVerifier;
  // ts/packages/db の recordWebhookEventOnce を pool 束縛した関数（実配線はタスク 4.2）。
  recordWebhookEventOnce: (webhookEventId: string) => Promise<boolean>;
  conversationHandlers: ConversationHandlers;
  // エラー境界（Requirement 7.5）が汎用の再試行案内 reply を試みるためだけに必要なため、
  // LineMessenger 全体ではなく reply のみを要求する（狭い契約 = 誤用の余地を減らす）。
  messenger: Pick<LineMessenger, 'reply'>;
  logger: AppLogger;
}

const SIGNATURE_HEADER = 'x-line-signature';
// design.md「Error Handling」「Monitoring」: 内部障害の structured log には
// X-Line-Request-Id を併記する（LINE はログを提供しないため、追跡キーを自前で残す）。
const REQUEST_ID_HEADER = 'x-line-request-id';

// Hono アプリのファクトリ（実起動なしで app.request でテスト可能）。
// 本タスク（4.1）: 署名検証（1.4）＋イベントディスパッチャ（2.1）＋会話ハンドラ（3.x）を
// POST /webhook に配線し、Requirement 7.1（未検証リクエストの不処理）・
// Requirement 7.5（内部例外時の再試行案内 reply 試行）のエラー境界を構築する。
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.post('/webhook', async (c) => {
    const requestId = c.req.header(REQUEST_ID_HEADER);

    // dispatch() へ渡す onEvent は ConversationHandlers.handleEvent をそのまま渡すのではなく、
    // 「現在処理中のイベントの replyToken」を閉包変数として追跡する薄いラッパーにする。
    //
    // 理由（Requirement 7.5 のエラー境界設計・EXECUTION_PROTOCOL の検討事項）:
    // dispatch()（タスク 2.1・凍結済みの契約）は複数イベントをループ処理し、内部例外時は
    // 素の Error で reject するのみで「どのイベント/replyToken の処理中だったか」を
    // 呼び出し側へ構造的に伝えない。dispatch.ts・conversation.ts 自体は変更しない方針のため、
    // 本関数が dispatcher に注入する onEvent 自体でこの追跡を行う。
    // 処理開始時に replyToken を記録し、正常終了時にクリアすることで、例外発生時に
    // 「まだ reply 消費されていない、直近処理中イベントの replyToken」だけを安全に保持できる
    // （同一イベントで reply 済みの後に例外が起きた場合はすでに clear 済みのため、
    // 使用済み replyToken を誤って再利用することはない。JSON parse 失敗など、
    // イベントループに入る前の例外では null のまま＝再試行 reply は試みない）。
    //
    // 重要: この閉包変数（inFlightReplyToken）と dispatcher インスタンスは、
    // createApp() 呼び出し時（アプリ生存期間全体で1つ）ではなく、
    // 本リクエストハンドラの呼び出しごと（リクエストごとに1つ）に生成する。
    // Cloud Run の containerConcurrency はデフォルトで同一インスタンス上の複数リクエストを
    // 並行処理し得るため、createApp() スコープに置くと並行 POST /webhook 間で
    // この状態が共有され、片方の成功によるクリアがもう片方の失敗時の
    // 再試行案内 reply を誤って握りつぶす（あるいは他リクエストの replyToken を
    // 誤って使い回す）レースコンディションを引き起こす。
    let inFlightReplyToken: string | null = null;

    const dispatcher = createEventDispatcher({
      recordWebhookEventOnce: deps.recordWebhookEventOnce,
      onEvent: async (event: InboundEvent) => {
        inFlightReplyToken = event.replyToken;
        await deps.conversationHandlers.handleEvent(event);
        inFlightReplyToken = null;
      },
    });

    // Requirement 7.1: 署名検証は raw body（JSON parse 前）で行う。c.req.json() を先に
    // 呼ぶとボディストリームが消費・再構成され検証に使えなくなるため、
    // 必ず c.req.text() を最初に呼び、検証を通過するまで本文をいかなる処理にも使わない。
    const rawBody = await c.req.text();
    const signatureHeader = c.req.header(SIGNATURE_HEADER);

    if (!deps.signatureVerifier.verify(rawBody, signatureHeader)) {
      // 署名不一致・ヘッダ欠落: 本文は一切処理せず 401 を返す（dispatcher は呼ばない）。
      return c.body(null, 401);
    }

    try {
      await dispatcher.dispatch(rawBody);
      return c.json({ status: 'ok' }, 200);
    } catch (err) {
      // Requirement 7.5: 内部例外（DB エラー・想定外のパース失敗・下流の未捕捉例外等）。
      //
      // HTTP ステータスの判断根拠（design.md「Error Handling」・research.md「Decision 1」）:
      // design.md は「内部障害は汎用の再試行案内 reply を試行。reply 自体の失敗は
      // structured log に記録し 200 を返す（LINE への 5xx は再配信を誘発するため、
      // 冪等化済みでも意図的な再配信要求時以外は 200 とする）」と明記している。
      // これは research.md Decision 1 の設計意図（LINE 再配信＋webhookEventId 冪等化は
      // 「コールドスタート等によるタイムアウトで 2 秒以内に応答できなかった」場合の
      // 未達を再配信で救済する仕組み）とも整合する。dispatch.ts の実装上、
      // recordWebhookEventOnce は各イベントの実処理（onEvent 呼び出し）の“前”に
      // 記録されるため、ここで内部例外が起きた時点でそのイベントは既に「処理試行済み」
      // として記録済みであり、LINE が 5xx を見て再配信しても dedup により同一イベントは
      // 再処理されずスキップされるだけで、実質的な再試行効果は得られない。
      // つまり 500 を返しても「redelivery による回復」という利益は得られず、
      // 得られるのは再配信の追加コスト（無意味な再送ループの原因になり得る）のみである。
      // よって本境界は常に 200 を返す（500 は選択しない）。
      const replyToken = inFlightReplyToken;
      inFlightReplyToken = null;

      deps.logger.error('line-webhook: internal error while dispatching webhook event', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });

      if (replyToken) {
        try {
          await deps.messenger.reply(replyToken, [buildInternalErrorRetryMessage()]);
        } catch (replyErr) {
          // design.md「reply 失敗は structured log（X-Line-Request-Id 併記）に記録」。
          deps.logger.error('line-webhook: retry-guidance reply attempt failed', {
            error: replyErr instanceof Error ? replyErr.message : String(replyErr),
            requestId,
          });
        }
      } else {
        // JSON parse 失敗等、イベントの replyToken が判明する前に例外が発生した場合。
        // 宛先不明のため reply は試みようがない（誤った/使用済みの replyToken を
        // 推測で使うことは行わない）。その旨も structured log（X-Line-Request-Id 併記）に記録する。
        deps.logger.error(
          'line-webhook: internal error occurred before any replyToken was known; retry-guidance reply not attempted',
          { requestId },
        );
      }

      return c.json({ status: 'ok' }, 200);
    }
  });

  return app;
}

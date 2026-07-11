import { serve } from '@hono/node-server';
import { createApp, type AppDeps } from './app.js';
import { loadConfig } from './config.js';
import { createSignatureVerifier } from './webhook/signature.js';

// Cloud Run エントリ。必須 env を検証してから起動する。
//
// 本タスク（4.1）は createApp(deps) の配線とエラー境界（署名検証・イベントディスパッチャ・
// 会話ハンドラの結線、内部例外時の再試行案内 reply 試行）の構築のみを担当する。
// pg pool・Places fetch クライアント・LINE messenger 等の実依存の配線は次タスク（4.2・
// 「実依存注入とアプリレベルフローテスト」）の責務であり、本タスクでは意図的に持ち込まない。
//
// createApp が deps を必須引数に取るようになったため（署名検証を素通りさせないための
// Requirement 7.1 の構造的強制）、ビルドを通す最小限の措置として、まだ実配線されていない
// 依存はここでは「呼び出されたら明示的に失敗する」プレースホルダに留める。サイレントに
// 誤動作する（例: recordWebhookEventOnce が常に true を返す等）よりも、実際に呼ばれた際に
// 即座にエラーとして顕在化する方が安全なため。タスク 4.2 でこれらを実依存に置き換える。
const config = loadConfig();

function notWiredYet(name: string): never {
  throw new Error(
    `line-webhook: ${name} is not wired to a real dependency yet (pending task 4.2)`,
  );
}

const deps: AppDeps = {
  // 署名検証は LINE_CHANNEL_SECRET のみで構築可能な純粋な暗号検証であり、
  // pool/fetch のような未配線の外部依存を必要としないため、ここで実配線する。
  signatureVerifier: createSignatureVerifier(config.lineChannelSecret),
  recordWebhookEventOnce: () => notWiredYet('recordWebhookEventOnce (DB pool)'),
  conversationHandlers: {
    handleEvent: () => notWiredYet('ConversationHandlers (DB pool / Places / LINE messenger)'),
  },
  messenger: {
    reply: () => notWiredYet('LineMessenger.reply'),
  },
  logger: {
    // LINE はログを提供しないため自前で標準出力へ記録する。
    error: (message, meta) => {
      console.error(message, meta ?? {});
    },
  },
};

const app = createApp(deps);

serve({ fetch: app.fetch, port: config.port });

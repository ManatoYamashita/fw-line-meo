import { serve } from '@hono/node-server';
import { writeStructuredLog } from '@fwlm/observability';
import {
  getPool,
  recordWebhookEventOnce as dbRecordWebhookEventOnce,
  getOrCreateSession,
  updateSession,
  findOwnerByLineUserId,
  findOwnerById,
  createOwner,
  findActiveInviteCode,
  createAuditLog,
} from '@fwlm/db';
import { createApp, type AppDeps } from './app.js';
import { loadConfig, type GbpConfig } from './config.js';
import { createSignatureVerifier } from './webhook/signature.js';
import { createPlacesSearchAdapter } from '@fwlm/store-identification';
import { createLineMessenger } from './line/client.js';
import { createStoreIdentificationService } from '@fwlm/store-identification';
import { createConversationHandlers } from './onboarding/conversation.js';
import { createStoreIdentifiedOwnerRouterFactory } from './owner/router.js';
import { createGbpClient } from './gbp/client.js';
import { createGoogleRefreshGrantClient, createTokenStore } from './gbp/token-store.js';
import {
  createDefaultGbpOauthAccessors,
  createGbpOauthService,
  createGoogleOauthCodeClient,
} from './gbp/oauth.js';
import { createGbpOauthCallbackRoute } from './gbp/callback.js';
import { createDefaultGbpFlowAccessors, createGbpFlowHandlers } from './gbp/flows.js';
import { createDefaultGbpPrompts } from './gbp/prompts.js';
import { createDefaultGbpLogger } from './gbp/logger.js';

// Cloud Run エントリ。必須 env を検証してから起動する。
//
// 本タスク（4.2）は、タスク 4.1 が構築した createApp(deps) のエラー境界に対し、
// すべての実依存（pg pool・Places fetch クライアント・LINE messenger・会話ハンドラ一式）を
// 実配線する。プレースホルダ（notWiredYet）は本タスクで全廃する。
const config = loadConfig();

// pg.Pool は Queryable（.query を持つ）と ConnectablePool（.connect() が
// TransactionClient 互換のオブジェクトを返す）の両方に構造的に適合するため、
// 同一の pool 値を db/pool 両方のフィールドに渡せる（onboarding/conversation.ts の
// ConversationDeps 設計コメント・onboarding/store-identification.ts と同じ前提）。
const pool = await getPool();

const placesAdapter = createPlacesSearchAdapter({ apiKey: config.placesApiKey, fetch });

const lineMessenger = createLineMessenger({
  channelId: config.lineChannelId,
  channelSecret: config.lineChannelSecret,
  fetch,
  logger: {
    warn: (event, fields) => {
      writeStructuredLog('warn', event, fields);
    },
  },
});

const storeIdentificationService = createStoreIdentificationService({
  pool,
  places: placesAdapter,
});

// GBP 連携（gbp-post-review-reply）。**既定 OFF**（Issue #323）。GBP の env が無ければ何も組み立てず、
// 会話から GBP への委譲も OAuth callback の経路も登録しない。GBP の会話は gbp_sessions を読むので、
// migration 0013 と grants が本番に当たる前に組み立てると、GBP を使わないオーナーの操作まで失敗しうる。
// 組み立てるのは、会話ハンドラが委譲先として受け取るので conversationHandlers より先である。
const gbp = config.gbp === null ? null : await buildGbp(config.gbp);
writeStructuredLog('info', gbp === null ? 'line-webhook.gbp_disabled' : 'line-webhook.gbp_enabled');

async function buildGbp(gbpConfig: GbpConfig) {
  const tokenStore = createTokenStore({
    cipherKeyBase64: gbpConfig.tokenCipherKey,
    refreshClient: createGoogleRefreshGrantClient({
      clientId: gbpConfig.oauthClientId,
      clientSecret: gbpConfig.oauthClientSecret,
    }),
  });
  const gbpClient = createGbpClient({ tokenStore, fetch });
  const oauth = createGbpOauthService({
    db: pool,
    pool,
    oauthClient: createGoogleOauthCodeClient({
      clientId: gbpConfig.oauthClientId,
      clientSecret: gbpConfig.oauthClientSecret,
      redirectUrl: gbpConfig.oauthRedirectUrl,
    }),
    gbpClient,
    tokenStore,
    ...createDefaultGbpOauthAccessors(),
    now: () => new Date(),
  });
  // 投稿・返信の下書き生成。pool は Queryable（db）と ConnectablePool（pool）の両方に構造的に適合する
  // （conversationHandlers と同じ前提）。
  // 生成器は GEMINI_API_KEY を環境変数から自動で読む（gbpConfig.geminiApiKey は起動時の存在確認のため）。
  const prompts = await createDefaultGbpPrompts();
  // GBP ドメイン共通のロガー。meta は allowlist なので本文・トークンは型として渡せない。
  const logger = createDefaultGbpLogger();
  const flowHandlers = createGbpFlowHandlers({
    db: pool,
    pool,
    oauth,
    tokenStore,
    ...createDefaultGbpFlowAccessors(),
    prompts,
    gbpClient,
    messenger: lineMessenger,
    logger,
    now: () => new Date(),
  });
  const oauthCallback = createGbpOauthCallbackRoute({
    db: pool,
    oauth,
    messenger: lineMessenger,
    owners: { findOwnerById },
    logger,
  });
  return { flowHandlers, oauthCallback };
}

const conversationHandlers = createConversationHandlers({
  db: pool,
  pool,
  sessions: { getOrCreateSession, updateSession },
  owners: { findOwnerByLineUserId, createOwner },
  inviteCodes: { findActiveInviteCode },
  identification: storeIdentificationService,
  messenger: lineMessenger,
  now: () => new Date(),
  // 補助的処理の成否を記録する。注入の口は合成ルートにある（Issue #228 タスク 4）。
  logger: {
    info: (event, fields) => {
      writeStructuredLog('info', event, fields);
    },
    warn: (event, fields) => {
      writeStructuredLog('warn', event, fields);
    },
  },
  auditLog: (input) => createAuditLog(pool, input),
  lineRichMenuCompletedId: config.lineRichMenuCompletedId,
  liffStoreDetailUrl: config.liffStoreDetailUrl,
  // 店舗特定済みオーナーの振り分け口とレポート応答（line-on-demand-report tasks 3.10）。ここで作るのは作り方だけで、
  // router と ReportHandler は会話がイベントごとに、そのリクエストのロガー（相関 ID つき）と Messenger で作る。
  createOwnerRouter: createStoreIdentifiedOwnerRouterFactory({
    db: pool,
    sessions: { getOrCreateSession, updateSession },
    auditLog: (input) => createAuditLog(pool, input),
    lineRichMenuCompletedId: config.lineRichMenuCompletedId,
    liffStoreDetailUrl: config.liffStoreDetailUrl,
    // GBP の会話へは振り分け口が渡す（店舗特定済みのオーナーだけが GBP を使う）。OFF のときは渡さない。
    ...(gbp ? { gbp: gbp.flowHandlers } : {}),
  }),
});

const deps: AppDeps = {
  // 署名検証は LINE_CHANNEL_SECRET のみで構築可能な純粋な暗号検証。
  signatureVerifier: createSignatureVerifier(config.lineChannelSecret),
  // recordWebhookEventOnce は pool 束縛済みの関数として渡す
  // （createApp が内部で EventDispatcher を構築する際にそのまま使う）。
  recordWebhookEventOnce: (webhookEventId) => dbRecordWebhookEventOnce(pool, webhookEventId),
  conversationHandlers,
  messenger: lineMessenger,
  // GBP が OFF のときは経路そのものを登録しない（項目を持たなければ createApp は登録を飛ばす）。
  ...(gbp ? { gbpOauthCallback: gbp.oauthCallback } : {}),
  logger: {
    // LINE はログを提供しないため自前で記録する。出力は共有経路が担う。
    error: (event, fields) => {
      writeStructuredLog('error', event, fields);
    },
  },
  // Issue #230: ログベース指標が読む 1 行 JSON の出力先。allowlist sink なので、
  // 型を通り抜けた余剰プロパティが Cloud Logging へ永続化されることはない。
  structuredLog: writeStructuredLog,
};

const app = createApp(deps);

serve({ fetch: app.fetch, port: config.port });

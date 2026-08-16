import { serve } from '@hono/node-server';
import {
  getPool,
  recordWebhookEventOnce as dbRecordWebhookEventOnce,
  getOrCreateSession,
  updateSession,
  findOwnerByLineUserId,
  findOwnerById,
  createOwner,
  findActiveInviteCode,
} from '@fwlm/db';
import { createApp, type AppDeps } from './app.js';
import { loadConfig } from './config.js';
import { createSignatureVerifier } from './webhook/signature.js';
import { createPlacesSearchAdapter } from '@fwlm/store-identification';
import { createLineMessenger } from './line/client.js';
import { createStoreIdentificationService } from '@fwlm/store-identification';
import { createConversationHandlers } from './onboarding/conversation.js';
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
    warn: (message, meta) => {
      console.warn(message, meta ?? {});
    },
  },
});

const storeIdentificationService = createStoreIdentificationService({
  pool,
  places: placesAdapter,
});

// GBP OAuth（gbp-post-review-reply spec task 3.1・3.2）。
// task 3.3 で会話フロー（GbpFlows）も配線したため、conversationHandlers より先に構築する
// （conversationHandlers が GbpFlows を委譲先として受け取るため）。
const gbpTokenStore = createTokenStore({
  cipherKeyBase64: config.gbpTokenCipherKey,
  refreshClient: createGoogleRefreshGrantClient({
    clientId: config.gbpOauthClientId,
    clientSecret: config.gbpOauthClientSecret,
  }),
});

const gbpClient = createGbpClient({ tokenStore: gbpTokenStore, fetch });

const gbpOauthService = createGbpOauthService({
  db: pool,
  pool,
  oauthClient: createGoogleOauthCodeClient({
    clientId: config.gbpOauthClientId,
    clientSecret: config.gbpOauthClientSecret,
    redirectUrl: config.gbpOauthRedirectUrl,
  }),
  gbpClient,
  tokenStore: gbpTokenStore,
  ...createDefaultGbpOauthAccessors(),
  now: () => new Date(),
});

// task 3.3: 連携系（connect / status / disconnect）の会話フロー。
// task 4.1: 投稿フロー（下書き生成 → 承認 → 投稿）を同ハンドラへ追加配線する。
// pool は Queryable（db）と ConnectablePool（pool）の両方に構造的に適合する
// （conversationHandlers と同じ前提）。
const gbpPrompts = await createDefaultGbpPrompts();

const gbpFlowHandlers = createGbpFlowHandlers({
  db: pool,
  pool,
  oauth: gbpOauthService,
  tokenStore: gbpTokenStore,
  ...createDefaultGbpFlowAccessors(),
  prompts: gbpPrompts,
  gbpClient,
  messenger: lineMessenger,
  now: () => new Date(),
});

const conversationHandlers = createConversationHandlers({
  db: pool,
  pool,
  sessions: { getOrCreateSession, updateSession },
  owners: { findOwnerByLineUserId, createOwner },
  inviteCodes: { findActiveInviteCode },
  identification: storeIdentificationService,
  messenger: lineMessenger,
  now: () => new Date(),
  lineRichMenuCompletedId: config.lineRichMenuCompletedId,
  liffStoreDetailUrl: config.liffStoreDetailUrl,
  gbp: gbpFlowHandlers,
});

const gbpOauthCallback = createGbpOauthCallbackRoute({
  db: pool,
  oauth: gbpOauthService,
  messenger: lineMessenger,
  owners: { findOwnerById },
  logger: {
    error: (message, meta) => {
      console.error(message, meta ?? {});
    },
    warn: (message, meta) => {
      console.warn(message, meta ?? {});
    },
  },
});

const deps: AppDeps = {
  // 署名検証は LINE_CHANNEL_SECRET のみで構築可能な純粋な暗号検証。
  signatureVerifier: createSignatureVerifier(config.lineChannelSecret),
  // recordWebhookEventOnce は pool 束縛済みの関数として渡す
  // （createApp が内部で EventDispatcher を構築する際にそのまま使う）。
  recordWebhookEventOnce: (webhookEventId) => dbRecordWebhookEventOnce(pool, webhookEventId),
  conversationHandlers,
  messenger: lineMessenger,
  gbpOauthCallback,
  logger: {
    // LINE はログを提供しないため自前で標準出力へ記録する。
    error: (message, meta) => {
      console.error(message, meta ?? {});
    },
  },
};

const app = createApp(deps);

serve({ fetch: app.fetch, port: config.port });

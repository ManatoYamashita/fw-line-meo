// line-webhook の実行時設定。必須 env を起動時に検証する（欠落は明示エラーで fail-fast）。

export interface LineWebhookConfig {
  lineChannelId: string;
  lineChannelSecret: string;
  placesApiKey: string;
  lineRichMenuCompletedId: string;
  // 完了メッセージ（Issue #21）が機能1の詳細（store-detail LIFF）への導線ボタンに使う URL。
  // 環境依存（本番/検証で liff_id が異なる）のため env から注入する。
  liffStoreDetailUrl: string;
  // GBP 連携（gbp-post-review-reply）。**既定 OFF**（Issue #323）。GBP の env が 1 つも無ければ null で、
  // GBP の経路（OAuth callback・GBP の postback・会話からの委譲）を一切登録しない。本番は GBP API の利用承認と
  // OAuth クライアントの作成が済むまでこの状態で動く。
  gbp: GbpConfig | null;
  port: number;
}

export interface GbpConfig {
  // client id / redirect URL は非秘匿 env、client secret は Secret Manager（gbp-oauth-client-secret）由来。
  oauthClientId: string;
  oauthClientSecret: string;
  oauthRedirectUrl: string;
  // refresh token 暗号化鍵（AES-256-GCM・32 byte base64）。Secret Manager（gbp-token-cipher-key）由来。
  tokenCipherKey: string;
  // 投稿・返信の下書き生成用。既存 secret gemini-api-key を line-webhook にも配線して注入する。
  // 生成器（@fwlm/gemini）は環境変数から自動で読むので、ここでは存在の確認だけに使う。
  geminiApiKey: string;
}

/** GBP を有効にする env。**全部あるか、全部無いか**のどちらかでなければならない。 */
export const GBP_ENV_KEYS = [
  'GBP_OAUTH_CLIENT_ID',
  'GBP_OAUTH_CLIENT_SECRET',
  'GBP_OAUTH_REDIRECT_URL',
  'GBP_TOKEN_CIPHER_KEY',
] as const;

/**
 * GBP の設定を読む。GBP の env が 1 つも無ければ null（既定 OFF）。
 *
 * **一部だけあるときは起動時に落とす。** 入れ忘れを黙って OFF にすると、有効にしたつもりの運用者は
 * 「なぜ GBP の導線が出ないのか」をログから辿れない。GEMINI_API_KEY は survey-web と共有の secret で、
 * GBP を ON にするときだけ line-webhook が要求する（OFF のときは読まない）。
 */
export function loadGbpConfig(env: NodeJS.ProcessEnv): GbpConfig | null {
  const present = GBP_ENV_KEYS.filter((key) => Boolean(env[key]));
  if (present.length === 0) return null;
  const missing = GBP_ENV_KEYS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(
      `GBP の env が一部だけ設定されています（不足: ${missing.join(', ')}）。有効にするなら全部、無効にするなら全部外してください`,
    );
  }
  return {
    oauthClientId: required(env, 'GBP_OAUTH_CLIENT_ID'),
    oauthClientSecret: required(env, 'GBP_OAUTH_CLIENT_SECRET'),
    oauthRedirectUrl: required(env, 'GBP_OAUTH_REDIRECT_URL'),
    tokenCipherKey: required(env, 'GBP_TOKEN_CIPHER_KEY'),
    geminiApiKey: required(env, 'GEMINI_API_KEY'),
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LineWebhookConfig {
  return {
    lineChannelId: required(env, 'LINE_CHANNEL_ID'),
    lineChannelSecret: required(env, 'LINE_CHANNEL_SECRET'),
    placesApiKey: required(env, 'PLACES_API_KEY'),
    lineRichMenuCompletedId: required(env, 'LINE_RICHMENU_COMPLETED_ID'),
    liffStoreDetailUrl: required(env, 'LIFF_STORE_DETAIL_URL'),
    gbp: loadGbpConfig(env),
    port: Number(env.PORT ?? '8080'),
  };
}

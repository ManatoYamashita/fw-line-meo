// line-webhook の実行時設定。必須 env を起動時に検証する（欠落は明示エラーで fail-fast）。

export interface LineWebhookConfig {
  lineChannelId: string;
  lineChannelSecret: string;
  placesApiKey: string;
  lineRichMenuCompletedId: string;
  // 完了メッセージ（Issue #21）が機能1の詳細（store-detail LIFF）への導線ボタンに使う URL。
  // 環境依存（本番/検証で liff_id が異なる）のため env から注入する。
  liffStoreDetailUrl: string;
  // GBP OAuth（gbp-post-review-reply / Req 2.1）。client id / redirect URL は非秘匿 env、
  // client secret は Secret Manager（gbp-oauth-client-secret）由来。
  gbpOauthClientId: string;
  gbpOauthClientSecret: string;
  gbpOauthRedirectUrl: string;
  // refresh token 暗号化鍵（AES-256-GCM・32 byte base64）。Secret Manager（gbp-token-cipher-key）由来。
  gbpTokenCipherKey: string;
  // 投稿・返信の下書き生成用。既存 secret gemini-api-key を line-webhook にも配線して注入する。
  geminiApiKey: string;
  port: number;
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
    gbpOauthClientId: required(env, 'GBP_OAUTH_CLIENT_ID'),
    gbpOauthClientSecret: required(env, 'GBP_OAUTH_CLIENT_SECRET'),
    gbpOauthRedirectUrl: required(env, 'GBP_OAUTH_REDIRECT_URL'),
    gbpTokenCipherKey: required(env, 'GBP_TOKEN_CIPHER_KEY'),
    geminiApiKey: required(env, 'GEMINI_API_KEY'),
    port: Number(env.PORT ?? '8080'),
  };
}

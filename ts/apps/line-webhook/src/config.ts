// line-webhook の実行時設定。必須 env を起動時に検証する（欠落は明示エラーで fail-fast）。

export interface LineWebhookConfig {
  lineChannelId: string;
  lineChannelSecret: string;
  placesApiKey: string;
  lineRichMenuCompletedId: string;
  // 完了メッセージ（Issue #21）が機能1の詳細（store-detail LIFF）への導線ボタンに使う URL。
  // 環境依存（本番/検証で liff_id が異なる）のため env から注入する。
  liffStoreDetailUrl: string;
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
    port: Number(env.PORT ?? '8080'),
  };
}

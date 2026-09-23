// dashboard-api の実行時設定。必須 env を起動時に検証する（欠落は明示エラーで fail-fast）。

export interface DashboardApiConfig {
  surveyBaseUrl: string;
  // CORS で許可するオリジン（dashboard-web の配信元。design Security Considerations）。
  // 通常は 1 つ。独自ドメインへの移行期間だけ、新旧 2 つを完全一致で許可する（Issue #146）。
  corsOrigin: string | readonly string[];
  // Places API (New) の API キー（PlacesSearchAdapter が使用）。
  placesApiKey: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DashboardApiConfig {
  const surveyBaseUrl = env.SURVEY_BASE_URL;
  if (!surveyBaseUrl) {
    throw new Error('SURVEY_BASE_URL is required');
  }
  const corsOrigin = parseCorsOrigins(env.DASHBOARD_WEB_ORIGIN);
  const placesApiKey = env.PLACES_API_KEY;
  if (!placesApiKey) {
    throw new Error('PLACES_API_KEY is required');
  }
  return {
    surveyBaseUrl,
    corsOrigin,
    placesApiKey,
    port: Number(env.PORT ?? '8080'),
  };
}

/**
 * DASHBOARD_WEB_ORIGIN をカンマ区切りで読む。1 つなら文字列のまま返す（従来どおり）。
 * 各要素はパスも末尾スラッシュも持たないオリジンでなければならない。CORS は完全一致で比べるので、
 * `https://a.example/` のような値は黙って全拒否になる。起動時に弾いて気づけるようにする。
 */
export function parseCorsOrigins(raw: string | undefined): string | readonly string[] {
  const origins = (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');
  if (origins.length === 0) {
    throw new Error('DASHBOARD_WEB_ORIGIN is required');
  }
  for (const o of origins) {
    let parsed: URL;
    try {
      parsed = new URL(o);
    } catch {
      throw new Error(`DASHBOARD_WEB_ORIGIN にオリジンでない値があります: ${o}`);
    }
    if (parsed.origin !== o) {
      throw new Error(`DASHBOARD_WEB_ORIGIN にオリジンでない値があります: ${o}`);
    }
  }
  return origins.length === 1 ? origins[0]! : origins;
}

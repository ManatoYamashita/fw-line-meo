// dashboard-api の実行時設定。必須 env を起動時に検証する（欠落は明示エラーで fail-fast）。

export interface DashboardApiConfig {
  surveyBaseUrl: string;
  // CORS で許可する単一オリジン（dashboard-web の配信元。design Security Considerations）。
  corsOrigin: string;
  // Places API (New) の API キー（PlacesSearchAdapter が使用）。
  placesApiKey: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DashboardApiConfig {
  const surveyBaseUrl = env.SURVEY_BASE_URL;
  if (!surveyBaseUrl) {
    throw new Error('SURVEY_BASE_URL is required');
  }
  const corsOrigin = env.DASHBOARD_WEB_ORIGIN;
  if (!corsOrigin) {
    throw new Error('DASHBOARD_WEB_ORIGIN is required');
  }
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

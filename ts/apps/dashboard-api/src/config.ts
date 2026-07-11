// dashboard-api の実行時設定。必須 env を起動時に検証する（欠落は明示エラーで fail-fast）。

export interface DashboardApiConfig {
  surveyBaseUrl: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DashboardApiConfig {
  const surveyBaseUrl = env.SURVEY_BASE_URL;
  if (!surveyBaseUrl) {
    throw new Error('SURVEY_BASE_URL is required');
  }
  return {
    surveyBaseUrl,
    port: Number(env.PORT ?? '8080'),
  };
}

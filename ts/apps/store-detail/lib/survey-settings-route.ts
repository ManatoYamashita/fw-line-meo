// アンケート設定 API の route.ts が共有する実依存の配線（Issue #437）。
//
// 認可の設定（LIFF チャネル ID・テスト用の検証エンドポイント）は詳細 API（app/api/detail/route.ts）と
// 同じ env を同じ意味で読む。LIFF_VERIFY_ENDPOINT は本番では未設定で、LINE 本番の検証エンドポイントを使う。

import { createAuditLog, getPool } from '@fwlm/db';
import {
  correlationIdFromHeaders,
  supportCodeFromCorrelationId,
  withCorrelation,
  writeStructuredLog,
} from '@fwlm/observability';

import { authorizeStoreDetailRequest, type LiffAuthOptions } from './liff-auth';
import { handleSurveySettings, type SurveySettingsOperation } from './survey-settings-api';

function jsonError(status: number, code: string, message: string, supportCode: string | undefined): Response {
  return new Response(JSON.stringify({ error: { code, message }, ...(supportCode ? { supportCode } : {}) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorKindOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'UnknownError';
}

/** route.ts から呼ぶ入口。設定・接続の不備は 500 にし、それ以外は handleSurveySettings へ委ねる。 */
export async function runSurveySettingsRoute(req: Request, operation: SurveySettingsOperation): Promise<Response> {
  const correlationId = correlationIdFromHeaders(req.headers);
  const log = withCorrelation(writeStructuredLog, correlationId);
  const supportCode = supportCodeFromCorrelationId(correlationId);

  const clientId = process.env.LIFF_CHANNEL_ID;
  if (!clientId) {
    log('error', 'store-detail.survey_settings_error', { errorKind: 'MissingConfigError', configKey: 'LIFF_CHANNEL_ID' });
    return jsonError(500, 'INTERNAL', 'サーバーエラー', supportCode);
  }
  const verifyEndpoint = process.env.LIFF_VERIFY_ENDPOINT;
  const liffOptions: LiffAuthOptions = verifyEndpoint ? { verifyEndpoint } : {};

  let pool: Awaited<ReturnType<typeof getPool>>;
  try {
    pool = await getPool();
  } catch (err) {
    log('error', 'store-detail.survey_settings_error', { errorKind: errorKindOf(err) });
    return jsonError(500, 'INTERNAL', 'サーバーエラー', supportCode);
  }

  return handleSurveySettings(req, operation, {
    authorize: (idToken) => authorizeStoreDetailRequest(idToken, clientId, pool, liffOptions),
    pool,
    auditLog: (input) => createAuditLog(pool, input),
    log,
    supportCode,
  });
}

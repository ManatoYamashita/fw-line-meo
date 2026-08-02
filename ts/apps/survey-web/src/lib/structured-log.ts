import type { DraftError, DraftErrorKind } from './draft/generator';

export type LogLevel = 'warn' | 'error' | 'info';
export interface SurveyLogFields {
  errorKind: DraftErrorKind;
  status?: number;
}
export type SurveyLogger = (level: LogLevel, event: string, fields?: SurveyLogFields) => void;

/** 生成失敗の診断情報だけを、プライバシーを保って記録する。 */
export function logGenerationFailure(log: SurveyLogger, error: DraftError): void {
  const fields: SurveyLogFields =
    error.kind === 'API_ERROR' && error.status !== undefined
      ? { errorKind: error.kind, status: error.status }
      : { errorKind: error.kind };

  if (error.kind === 'SAFETY_BLOCKED') {
    log('info', 'generation_safety_blocked', fields);
  } else {
    log('error', 'generation_failed', fields);
  }
}

/** Cloud Logging が解釈できる 1 行 JSON を出力する。 */
export const writeStructuredLog: SurveyLogger = (level, event, fields) => {
  console[level](JSON.stringify({ level, event, ...(fields ?? {}) }));
};

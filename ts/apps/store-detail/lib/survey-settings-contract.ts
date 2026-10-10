// /api/survey-settings の応答契約（Issue #437）。
//
// lib/survey-settings-api.ts（サーバー）と app/store/survey-settings（クライアント）の両方が参照する。
// lib/contract.ts と同じく、このファイルはクライアントバンドルに取り込まれる。`@fwlm/db` からは型だけを
// 取り込み、入力規則の値は pg を含まないサブパス `@fwlm/db/survey-settings-rules` から取り込む
// （ts/eslint.config.js の no-restricted-imports が機械強制する）。
//
// **storeId は認可の入力ではない。** 店舗は LIFF の ID トークンの sub から解決した認可済み集合の中で
// だけ選ばれる（lib/liff-auth.ts）。複数店舗のオーナーだけが、詳細画面と同じく `?storeId=` のヒントで
// 集合の中の 1 店を指す。本文（JSON）の storeId は読まない。

import type { StoreSurveySettings } from '@fwlm/db';
import type { StoreRef } from './contract';

/** 設定の読み取りと、変更の成功時に返す 200 応答（変更の後の設定を丸ごと返す）。 */
export interface SurveySettingsResponse extends StoreSurveySettings {
  readonly storeId: string;
  readonly storeName: string;
  readonly stores: readonly StoreRef[];
}

/** 失敗の応答の本文（`{ error: { code, message } }`・既存の API と同じ封筒）。 */
export interface SurveySettingsErrorBody {
  readonly error: { readonly code: string; readonly message: string };
  readonly supportCode?: string;
}

/** API のパス。URL に storeId を持たない（ヒントは `?storeId=` だけ）。 */
export const SURVEY_SETTINGS_PATHS = {
  settings: '/api/survey-settings',
  targets: '/api/survey-settings/targets',
  target: (targetId: string) => `/api/survey-settings/targets/${encodeURIComponent(targetId)}`,
  disableTarget: (targetId: string) => `/api/survey-settings/targets/${encodeURIComponent(targetId)}/disable`,
  order: '/api/survey-settings/targets/order',
  category: (categoryCode: string) => `/api/survey-settings/categories/${encodeURIComponent(categoryCode)}`,
} as const;

/** 設定画面の URL（詳細画面からの導線）。ヒントは詳細画面と同じく `?storeId=`。 */
export function surveySettingsPageHref(storeId: string): string {
  return `/store/survey-settings?storeId=${encodeURIComponent(storeId)}`;
}

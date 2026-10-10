// 料理名・ドリンク名の登録（Issue #437）。本文 { categoryCode, label }。中核は lib/survey-settings-api.ts。
// 非表示の同名があれば、新しい行を作らずにその行を再表示する（同じ UUID）。
import { runSurveySettingsRoute } from '../../../../lib/survey-settings-route';

// pg / cloud-sql-connector を使うため Node ランタイムが必須（Edge 不可）。認可で応答が変わるので静的化しない。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return runSurveySettingsRoute(req, { kind: 'addTarget' });
}

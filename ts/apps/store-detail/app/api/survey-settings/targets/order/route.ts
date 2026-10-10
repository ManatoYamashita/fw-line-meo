// 料理名・ドリンク名の並び替え（Issue #437）。本文 { categoryCode, targetIds }。中核は lib/survey-settings-api.ts。
import { runSurveySettingsRoute } from '../../../../../lib/survey-settings-route';

// pg / cloud-sql-connector を使うため Node ランタイムが必須（Edge 不可）。認可で応答が変わるので静的化しない。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PUT(req: Request): Promise<Response> {
  return runSurveySettingsRoute(req, { kind: 'reorderTargets' });
}

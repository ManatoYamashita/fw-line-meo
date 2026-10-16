// 店舗オーナーのアンケート設定の読み取り（Issue #437）。中核は lib/survey-settings-api.ts。
//   GET /api/survey-settings[?storeId=]（ヒントは認可済み集合の中でだけ解釈する）
import { runSurveySettingsRoute } from '../../../lib/survey-settings-route';

// pg / cloud-sql-connector を使うため Node ランタイムが必須（Edge 不可）。認可で応答が変わるので静的化しない。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request): Promise<Response> {
  return runSurveySettingsRoute(req, { kind: 'read' });
}

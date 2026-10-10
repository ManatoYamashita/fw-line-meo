// カテゴリ（MVP では予約・来店）の表示の切り替え（Issue #437）。本文 { enabled }。中核は lib/survey-settings-api.ts。
import { runSurveySettingsRoute } from '../../../../../lib/survey-settings-route';

// pg / cloud-sql-connector を使うため Node ランタイムが必須（Edge 不可）。認可で応答が変わるので静的化しない。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: Promise<{ categoryCode: string }> }): Promise<Response> {
  const { categoryCode } = await ctx.params;
  return runSurveySettingsRoute(req, { kind: 'setCategory', categoryCode });
}

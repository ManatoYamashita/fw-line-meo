// 料理名・ドリンク名の非表示（Issue #437）。行は消さない（active = false）。中核は lib/survey-settings-api.ts。
import { runSurveySettingsRoute } from '../../../../../../lib/survey-settings-route';

// pg / cloud-sql-connector を使うため Node ランタイムが必須（Edge 不可）。認可で応答が変わるので静的化しない。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ targetId: string }> }): Promise<Response> {
  const { targetId } = await ctx.params;
  return runSurveySettingsRoute(req, { kind: 'disableTarget', targetId });
}

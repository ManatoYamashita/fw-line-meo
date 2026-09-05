// Cloud Run 起動確認用のヘルスエンドポイント（依存なし）。
//
// 本ルートは Playwright の webServer が起動完了を待つ的でもある（Issue #53）。`/store` は
// LIFF の初期化を伴うため起動判定には使えず、`/` は存在しない。survey-web / dashboard-web と
// 同一の形にしてある。
export const dynamic = 'force-static';

export function GET(): Response {
  return Response.json({ status: 'ok' });
}

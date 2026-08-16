// Cloud Run 起動確認用のヘルスエンドポイント（依存なし）。
export const dynamic = 'force-static';

export function GET(): Response {
  return Response.json({ status: 'ok' });
}

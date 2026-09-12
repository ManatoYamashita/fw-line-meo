// Cloud Run 起動確認用のヘルスエンドポイント（依存なし）。
//
// `healthz` にしないこと。Cloud Run は z で終わる一部のパスを予約しており、本番では
// コンテナへ届く前に 404 が返る（Issue #219・scripts/check-cloud-run-reserved-paths.sh）。
export const dynamic = 'force-static';

export function GET(): Response {
  return Response.json({ status: 'ok' });
}

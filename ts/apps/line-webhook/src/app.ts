import { Hono } from 'hono';

// Hono アプリのファクトリ（実起動なしで app.request でテスト可能）。
// 本タスク（1.3）時点では GET /healthz のみを配線する。
// POST /webhook は署名検証（1.4）とディスパッチャ（2.1）が揃ってから 4.1 で配線する
// （Requirement 7.1: LINE プラットフォーム以外からの未検証リクエストを処理しないため）。
export function createApp(): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  return app;
}

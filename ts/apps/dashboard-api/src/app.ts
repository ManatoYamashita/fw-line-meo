import { Hono } from 'hono';

// Hono アプリのファクトリ（実起動なしで app.request でテスト可能）。
// QR ルート（5.3）はここに登録する。現状はヘルスのみ。
export function createApp(): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  return app;
}

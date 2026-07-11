import { Hono } from 'hono';
import { handleQr, type QrDeps } from './qr.js';

export interface AppDeps {
  qr: QrDeps;
}

const SIZE_MIN = 128;
const SIZE_MAX = 1024;
const SIZE_DEFAULT = 512;

/** ?size を 128–1024 に clamp（既定 512・不正値は既定）。 */
export function clampSize(raw: string | undefined): number {
  const n = Number(raw ?? SIZE_DEFAULT);
  if (!Number.isFinite(n)) return SIZE_DEFAULT;
  return Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.trunc(n)));
}

// Hono アプリのファクトリ（実起動なしで app.request でテスト可能）。
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.get('/stores/:storeId/qr.png', (c) => {
    const storeId = c.req.param('storeId');
    const size = clampSize(c.req.query('size'));
    const authorization = c.req.header('Authorization');
    return handleQr(deps.qr, { storeId, size, authorization });
  });

  return app;
}

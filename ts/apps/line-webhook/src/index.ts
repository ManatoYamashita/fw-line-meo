import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

// Cloud Run エントリ。必須 env を検証してから起動する。
// 実依存（bot-sdk / pool / places クライアント等）の配線は後続タスクで createApp に追加する。
const config = loadConfig();

const app = createApp();

serve({ fetch: app.fetch, port: config.port });

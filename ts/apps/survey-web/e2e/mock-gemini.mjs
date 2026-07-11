// E2E 用 Gemini モック。@google/genai の generateContent 呼出（generativelanguage）を MSW で傍受し、
// 固定の口コミ下書き JSON を返す。next プロセスへ NODE_OPTIONS='--import ./e2e/mock-gemini.mjs' で読み込む。
// 本番コードは一切変更しない（プロセスレベルの HTTP 傍受）。
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const server = setupServer(
  http.post('https://generativelanguage.googleapis.com/*', () =>
    HttpResponse.json({
      candidates: [
        {
          content: { parts: [{ text: JSON.stringify({ draft: 'E2E モックの口コミ下書きです。' }) }] },
          finishReason: 'STOP',
        },
      ],
    }),
  ),
);

server.listen({ onUnhandledRequest: 'bypass' });

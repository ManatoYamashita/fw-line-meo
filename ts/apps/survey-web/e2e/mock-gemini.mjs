// @ts-check
// E2E 用 Gemini モック。@google/genai の generateContent 呼出（generativelanguage）を MSW で傍受し、
// 固定の口コミ下書き JSON を返す。next プロセスへ NODE_OPTIONS='--import ./e2e/mock-gemini.mjs' で読み込む。
// 本番コードは一切変更しない（プロセスレベルの HTTP 傍受）。
//
// structured の Natural LLM Realizer（Issue #439）への呼出は、システム指示の先頭の印で見分け、プロンプトの「回答」の
// 行から下書きを組み立てて返す（固定の文では hard gate を通らず、E2E が safe fallback しか通らなくなるため）。
// 組み立てる文は safe fallback（「〇〇は味が良かったです」）と言い回しを変えてあり、画面に出た文で LLM の経路を
// 通ったことを確かめられる（「〇〇の味が良かったです」）。
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const REALIZER_MARKER = '[structured-review-realizer]';
const LEGACY_DRAFT = 'E2E モックの口コミ下書きです。';

/**
 * プロンプトの「回答」の行（`- 名前（カテゴリ）: 項目` / `- 項目（カテゴリ）`）から下書きを作る。
 * @param {string} contents
 * @returns {string}
 */
function realizedDraft(contents) {
  /** @type {string[]} */
  const sentences = [];
  /** @type {'positive' | 'concern' | null} */
  let polarity = null;
  for (const line of contents.split('\n')) {
    if (line.startsWith('良かったところ')) polarity = 'positive';
    else if (line.startsWith('気になったところ')) polarity = 'concern';
    else if (line.startsWith('- ') && polarity !== null) {
      const m = /^- (.+?)（.+?）(?:: (.+))?$/.exec(line);
      if (!m) continue;
      const verb = polarity === 'positive' ? '良かったです' : '気になりました';
      const facets = m[2] && !m[2].startsWith('料理・ドリンクそのもの') ? m[2].split('、').join('と') : null;
      sentences.push(facets ? `${m[1]}の${facets}が${verb}。` : `${m[1]}が${verb}。`);
    } else if (line.trim() === '') polarity = null;
  }
  return sentences.join('');
}

/**
 * generateContent の本文（文字列・{ parts: [{ text }] }・その配列）からテキストを取り出す。
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  const parts = /** @type {{ parts?: unknown }} */ (value).parts;
  if (Array.isArray(parts)) return parts.map((p) => /** @type {{ text?: string }} */ (p).text ?? '').join('\n');
  return '';
}

const server = setupServer(
  http.post('https://generativelanguage.googleapis.com/*', async ({ request }) => {
    let draft = LEGACY_DRAFT;
    try {
      const body = /** @type {{ systemInstruction?: unknown; contents?: unknown }} */ (await request.json());
      if (textOf(body.systemInstruction).includes(REALIZER_MARKER)) draft = realizedDraft(textOf(body.contents)) || LEGACY_DRAFT;
    } catch {
      // 本文を読めなければ legacy と同じ固定の文を返す。
    }
    return HttpResponse.json({
      candidates: [
        {
          content: { parts: [{ text: JSON.stringify({ draft }) }] },
          finishReason: 'STOP',
        },
      ],
    });
  }),
);

server.listen({ onUnhandledRequest: 'bypass' });

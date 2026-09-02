import { describe, it, expect } from 'vitest';
import {
  generateText,
  DEFAULT_SAFETY_SETTINGS,
  type GenAiClient,
  type GenAiRequest,
  type GenAiResponse,
  type SafetySetting,
} from '../src/index.js';

// 応答/例外を順に返しつつ、渡されたリクエストを記録するフェイク client。
function fakeClient(steps: Array<GenAiResponse | Error>): { client: GenAiClient; calls: GenAiRequest[] } {
  const calls: GenAiRequest[] = [];
  let i = 0;
  const client: GenAiClient = {
    models: {
      generateContent: (req) => {
        calls.push(req);
        const step = steps[Math.min(i, steps.length - 1)];
        i += 1;
        if (step instanceof Error) return Promise.reject(step);
        return Promise.resolve(step as GenAiResponse);
      },
    },
  };
  return { client, calls };
}

const NOOP_BACKOFF = () => Promise.resolve();

// 素通しの検証（trim のみ）。null で INVALID_OUTPUT になることは個別テストで検証する。
const passThrough = (text: string | undefined): string | null => text?.trim() ?? null;

function baseOptions(overrides: Partial<Parameters<typeof generateText>[1]> = {}) {
  return {
    model: 'gemini-test',
    contents: 'こんにちは',
    backoff: NOOP_BACKOFF,
    validateOutput: passThrough,
    ...overrides,
  };
}

describe('generateText', () => {
  it('正常応答から検証済みテキストを返す', async () => {
    const { client, calls } = fakeClient([{ text: '  良いお店でした  ' }]);
    const res = await generateText(client, baseOptions());
    expect(res).toEqual({ ok: true, value: '良いお店でした' });
    expect(calls[0]?.model).toBe('gemini-test');
    expect(calls[0]?.contents).toBe('こんにちは');
  });

  describe('safetySettings の透過', () => {
    it('未指定なら既定 4 カテゴリが BLOCK_MEDIUM_AND_ABOVE で必ず付与される（設定漏れ検知）', async () => {
      const { client, calls } = fakeClient([{ text: 'よい' }]);
      await generateText(client, baseOptions());
      const settings = calls[0]?.config.safetySettings as SafetySetting[];
      expect(settings).toHaveLength(4);
      expect(settings.map((s) => s.category)).toEqual([
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT',
      ]);
      expect(settings.every((s) => s.threshold === 'BLOCK_MEDIUM_AND_ABOVE')).toBe(true);
      expect(settings).toEqual([...DEFAULT_SAFETY_SETTINGS]);
    });

    it('明示指定した safetySettings がそのままリクエストに載る', async () => {
      const custom: SafetySetting[] = [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_LOW_AND_ABOVE' },
      ];
      const { client, calls } = fakeClient([{ text: 'よい' }]);
      await generateText(client, baseOptions({ safetySettings: custom }));
      expect(calls[0]?.config.safetySettings).toEqual(custom);
    });

    it('呼出側 config の他キー（systemInstruction 等）は safetySettings と共存して透過する', async () => {
      const { client, calls } = fakeClient([{ text: 'よい' }]);
      await generateText(
        client,
        baseOptions({
          config: { systemInstruction: '指示', temperature: 0.5, responseMimeType: 'application/json' },
        }),
      );
      const config = calls[0]?.config ?? {};
      expect(config.systemInstruction).toBe('指示');
      expect(config.temperature).toBe(0.5);
      expect(config.responseMimeType).toBe('application/json');
      expect(config.safetySettings).toBeDefined();
    });
  });

  describe('安全性ブロックの分類', () => {
    it('promptFeedback.blockReason があれば SAFETY_BLOCKED', async () => {
      const { client } = fakeClient([{ promptFeedback: { blockReason: 'SAFETY' } }]);
      const res = await generateText(client, baseOptions());
      expect(res).toEqual({ ok: false, error: { kind: 'SAFETY_BLOCKED' } });
    });

    it('候補の finishReason=SAFETY なら SAFETY_BLOCKED', async () => {
      const { client } = fakeClient([{ candidates: [{ finishReason: 'SAFETY' }], text: 'x' }]);
      const res = await generateText(client, baseOptions());
      expect(res).toEqual({ ok: false, error: { kind: 'SAFETY_BLOCKED' } });
    });
  });

  describe('出力検証', () => {
    it('validateOutput が null を返せば INVALID_OUTPUT', async () => {
      const { client } = fakeClient([{ text: 'raw' }]);
      const res = await generateText(client, baseOptions({ validateOutput: () => null }));
      expect(res).toEqual({ ok: false, error: { kind: 'INVALID_OUTPUT' } });
    });

    it('text が無い応答は validateOutput に undefined が渡る', async () => {
      const seen: Array<string | undefined> = [];
      const { client } = fakeClient([{}]);
      await generateText(
        client,
        baseOptions({
          validateOutput: (text) => {
            seen.push(text);
            return null;
          },
        }),
      );
      expect(seen).toEqual([undefined]);
    });

    it('validateOutput の返す変換後テキストが ok 値になる', async () => {
      const { client } = fakeClient([{ text: '{"draft":"抽出前"}' }]);
      const res = await generateText(client, baseOptions({ validateOutput: () => '抽出後' }));
      expect(res).toEqual({ ok: true, value: '抽出後' });
    });
  });

  describe('リトライとエラー分類', () => {
    it('5xx で 1 回だけ再試行し成功すれば ok（backoff は attempt=0 で呼ばれる）', async () => {
      const e = Object.assign(new Error('server'), { status: 503 });
      const attempts: number[] = [];
      const { client, calls } = fakeClient([e, { text: 'よい' }]);
      const res = await generateText(
        client,
        baseOptions({
          backoff: (attempt) => {
            attempts.push(attempt);
            return Promise.resolve();
          },
        }),
      );
      expect(res).toEqual({ ok: true, value: 'よい' });
      expect(calls).toHaveLength(2);
      expect(attempts).toEqual([0]);
    });

    it('429 の再試行後も失敗すれば API_ERROR（status 付き・呼出は 2 回で打ち止め）', async () => {
      const e = Object.assign(new Error('429'), { status: 429 });
      const { client, calls } = fakeClient([e, e, e]);
      const res = await generateText(client, baseOptions());
      expect(res).toEqual({ ok: false, error: { kind: 'API_ERROR', status: 429 } });
      expect(calls).toHaveLength(2);
    });

    it('非再試行エラー(4xx)は再試行せず API_ERROR（status 付き）', async () => {
      const e = Object.assign(new Error('bad'), { status: 400 });
      const { client, calls } = fakeClient([e, { text: 'よい' }]);
      const res = await generateText(client, baseOptions());
      expect(res).toEqual({ ok: false, error: { kind: 'API_ERROR', status: 400 } });
      expect(calls).toHaveLength(1);
    });

    it('status を持たない例外（ネットワーク断等）は 1 回だけ再試行する', async () => {
      const { client, calls } = fakeClient([new Error('network'), { text: 'よい' }]);
      const res = await generateText(client, baseOptions());
      expect(res).toEqual({ ok: true, value: 'よい' });
      expect(calls).toHaveLength(2);
    });

    it('status を持たない例外が再試行後も失敗すれば status なしの API_ERROR', async () => {
      const e = new Error('network');
      const { client, calls } = fakeClient([e, e, e]);
      const res = await generateText(client, baseOptions());
      expect(res).toEqual({ ok: false, error: { kind: 'API_ERROR' } });
      expect(calls).toHaveLength(2);
    });

    it('HTTP status として意味を成さない値（文字列・範囲外）は status に採用しない', async () => {
      const stringStatus = Object.assign(new Error('bad'), { status: '400' });
      const outOfRange = Object.assign(new Error('bad'), { status: 700 });
      // どちらも getHttpStatus が undefined を返すため、再試行判定は「status 不明」＝ 1 回再試行。
      for (const e of [stringStatus, outOfRange]) {
        const { client, calls } = fakeClient([e, e, e]);
        const res = await generateText(client, baseOptions());
        expect(res).toEqual({ ok: false, error: { kind: 'API_ERROR' } });
        expect(calls).toHaveLength(2);
      }
    });

    it('code プロパティ（5xx）でも再試行判定される', async () => {
      const e = Object.assign(new Error('server'), { code: 500 });
      const { client, calls } = fakeClient([e, { text: 'よい' }]);
      const res = await generateText(client, baseOptions());
      expect(res).toEqual({ ok: true, value: 'よい' });
      expect(calls).toHaveLength(2);
    });
  });
});

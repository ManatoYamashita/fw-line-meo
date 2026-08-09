import { describe, it, expect } from 'vitest';
import { createDraftGenerator, type GenAiClient, type GenAiRequest, type GenAiResponse } from '../src/lib/draft/generator';
import type { DraftMaterial } from '../src/lib/domain';

const MATERIAL: DraftMaterial = { storeName: '店', star: 5, aspectLabels: ['味'], comment: 'よい' };
const VARIATION = { tone: '丁寧な敬体', opening: '料理の感想から始める', angle: '味の具体性を重視' };
const NOOP_BACKOFF = () => Promise.resolve();

// 応答/例外を制御しつつ、渡されたリクエストを記録するフェイク client。
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

function draftResponse(draft: string): GenAiResponse {
  return { text: JSON.stringify({ draft }) };
}

describe('createDraftGenerator', () => {
  it('正常応答から下書きを返す', async () => {
    const { client } = fakeClient([draftResponse('とても良いお店でした。')]);
    const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
    const res = await gen.generate(MATERIAL, VARIATION);
    expect(res).toEqual({ ok: true, value: 'とても良いお店でした。' });
  });

  it('safetySettings 4 カテゴリが必ず BLOCK_MEDIUM_AND_ABOVE で付与される（設定漏れ検知）', async () => {
    const { client, calls } = fakeClient([draftResponse('よい')]);
    const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
    await gen.generate(MATERIAL, VARIATION);
    const settings = calls[0]?.config.safetySettings as Array<{ category: string; threshold: string }>;
    expect(settings).toHaveLength(4);
    const cats = settings.map((s) => s.category);
    expect(cats).toEqual([
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
    ]);
    expect(settings.every((s) => s.threshold === 'BLOCK_MEDIUM_AND_ABOVE')).toBe(true);
  });

  it('構造化出力(JSON schema)と temperature/mime を設定する', async () => {
    const { client, calls } = fakeClient([draftResponse('よい')]);
    const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
    await gen.generate(MATERIAL, VARIATION);
    const config = calls[0]?.config ?? {};
    expect(config.responseMimeType).toBe('application/json');
    expect(config.temperature).toBe(1.0);
    expect(config.responseSchema).toBeDefined();
  });

  describe('安全性ブロック', () => {
    it('promptFeedback.blockReason があれば SAFETY_BLOCKED', async () => {
      const { client } = fakeClient([{ promptFeedback: { blockReason: 'SAFETY' } }]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(MATERIAL, VARIATION)).toEqual({ ok: false, error: { kind: 'SAFETY_BLOCKED' } });
    });

    it('候補の finishReason=SAFETY なら SAFETY_BLOCKED', async () => {
      const { client } = fakeClient([{ candidates: [{ finishReason: 'SAFETY' }] }]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(MATERIAL, VARIATION)).toEqual({ ok: false, error: { kind: 'SAFETY_BLOCKED' } });
    });
  });

  describe('出力検証', () => {
    it('JSON でない応答は INVALID_OUTPUT', async () => {
      const { client } = fakeClient([{ text: 'これは JSON ではありません' }]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(MATERIAL, VARIATION)).toEqual({ ok: false, error: { kind: 'INVALID_OUTPUT' } });
    });

    it('draft キーが無い JSON は INVALID_OUTPUT', async () => {
      const { client } = fakeClient([{ text: JSON.stringify({ other: 'x' }) }]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(MATERIAL, VARIATION)).toEqual({ ok: false, error: { kind: 'INVALID_OUTPUT' } });
    });

    it('空の draft は INVALID_OUTPUT', async () => {
      const { client } = fakeClient([draftResponse('   ')]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(MATERIAL, VARIATION)).toEqual({ ok: false, error: { kind: 'INVALID_OUTPUT' } });
    });

    it('長すぎる draft(maxDraftChars 超過)は INVALID_OUTPUT', async () => {
      const { client } = fakeClient([draftResponse('あ'.repeat(401))]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF, maxDraftChars: 400 });
      expect(await gen.generate(MATERIAL, VARIATION)).toEqual({ ok: false, error: { kind: 'INVALID_OUTPUT' } });
    });

    it('前後空白は trim して返す', async () => {
      const { client } = fakeClient([draftResponse('  良い店  ')]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(MATERIAL, VARIATION)).toEqual({ ok: true, value: '良い店' });
    });
  });

  describe('再試行とエラー', () => {
    it('5xx で 1 回再試行し成功すれば ok', async () => {
      const e = Object.assign(new Error('server'), { status: 503 });
      const { client, calls } = fakeClient([e, draftResponse('よい')]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(MATERIAL, VARIATION)).toEqual({ ok: true, value: 'よい' });
      expect(calls).toHaveLength(2);
    });

    it('再試行後も失敗すれば API_ERROR', async () => {
      const e = Object.assign(new Error('429'), { status: 429 });
      const { client, calls } = fakeClient([e, e]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(MATERIAL, VARIATION)).toEqual({
        ok: false,
        error: { kind: 'API_ERROR', status: 429 },
      });
      expect(calls).toHaveLength(2);
    });

    it('非再試行エラー(4xx)は再試行せず API_ERROR', async () => {
      const e = Object.assign(new Error('bad'), { status: 400 });
      const { client, calls } = fakeClient([e, draftResponse('よい')]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(MATERIAL, VARIATION)).toEqual({
        ok: false,
        error: { kind: 'API_ERROR', status: 400 },
      });
      expect(calls).toHaveLength(1);
    });

    it('HTTP status を持たない例外は status なしの API_ERROR', async () => {
      const { client } = fakeClient([new Error('network')]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(MATERIAL, VARIATION)).toEqual({
        ok: false,
        error: { kind: 'API_ERROR' },
      });
    });

    // status の範囲・整数ガードを固定する。ガードが外れると gRPC の status code や
    // 不正値が HTTP status として構造化ログへ出て、運用の原因切り分けを誤らせる
    // （Issue #62 のログは「400 ならキー無効」と読むためのものであり、8 や 700 が
    // status として載ると読みが成立しない）。
    it('gRPC 相当の小さい status code は HTTP status として採用しない', async () => {
      // 8 = RESOURCE_EXHAUSTED。HTTP の 100-599 の外にあるため status には載せない。
      const e = Object.assign(new Error('resource exhausted'), { status: 8 });
      const { client } = fakeClient([e, e]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(MATERIAL, VARIATION)).toEqual({
        ok: false,
        error: { kind: 'API_ERROR' },
      });
    });

    it('HTTP の範囲外・非整数の status は採用しない', async () => {
      for (const bad of [700, 429.5]) {
        const e = Object.assign(new Error('bad status'), { status: bad });
        const { client } = fakeClient([e, e]);
        const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
        expect(await gen.generate(MATERIAL, VARIATION)).toEqual({
          ok: false,
          error: { kind: 'API_ERROR' },
        });
      }
    });

    it('数値でない status は採用せず、数値の code を再試行判定へ使う', async () => {
      // @google/genai 以外の層が status に文字列を載せる形。status は採用しないが、
      // code が数値なら再試行判定にはそちらを使う（429 なので 1 回だけ再試行する）。
      const e = Object.assign(new Error('rate limited'), { status: 'RESOURCE_EXHAUSTED', code: 429 });
      const { client, calls } = fakeClient([e, e]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(MATERIAL, VARIATION)).toEqual({
        ok: false,
        error: { kind: 'API_ERROR' },
      });
      expect(calls).toHaveLength(2);
    });
  });
});

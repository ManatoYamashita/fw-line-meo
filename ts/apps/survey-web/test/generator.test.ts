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

  // Issue #132・案B: 生成後に「客が選ばなかった観点へ言及していないか」を検証し、していれば
  // 1 回だけ作り直す。案A（プロンプトでの禁止）で 63.9%→11.1% まで下がった残差を刈るための層。
  describe('事実性の事後検証（Issue #132・案B）', () => {
    // 検証対象を 1 軸に絞った素材と、それに対応する最小の語彙。
    const WITH_CODES: DraftMaterial = {
      storeName: '店',
      star: 5,
      aspectLabels: ['味'],
      unselectedAspectLabels: ['雰囲気'],
      unselectedAspectCodes: ['atmosphere'],
    };
    const LEXICON = { atmosphere: ['雰囲気'] };

    it('未選択観点への言及を検出したら作り直し、解消した方を返す', async () => {
      const { client, calls } = fakeClient([draftResponse('雰囲気が良い店'), draftResponse('味が良い店')]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF, lexicon: LEXICON });
      const res = await gen.generate(WITH_CODES, VARIATION);
      expect(res).toEqual({ ok: true, value: '味が良い店' });
      expect(calls).toHaveLength(2);
    });

    it('作り直しは 1 回だけ。なお残るなら下書きを返しつつ残差を通知する', async () => {
      // fakeClient は steps を使い切ると最後の応答を繰り返すので、常に言及が残る状況になる。
      const seen: string[][] = [];
      const { client, calls } = fakeClient([draftResponse('雰囲気が良い店')]);
      const gen = createDraftGenerator(client, {
        backoff: NOOP_BACKOFF,
        lexicon: LEXICON,
        onResidual: (codes) => seen.push(codes),
      });
      const res = await gen.generate(WITH_CODES, VARIATION);
      // 客には下書きを返す（何も出さない方が実害が大きい）。合意水準 11.1% を受け入れた形。
      expect(res).toEqual({ ok: true, value: '雰囲気が良い店' });
      expect(calls).toHaveLength(2);
      expect(seen).toEqual([['atmosphere']]);
    });

    it('言及が無ければ作り直さない（無駄な課金とレイテンシを生まない）', async () => {
      const seen: string[][] = [];
      const { client, calls } = fakeClient([draftResponse('味が良い店')]);
      const gen = createDraftGenerator(client, {
        backoff: NOOP_BACKOFF,
        lexicon: LEXICON,
        onResidual: (codes) => seen.push(codes),
      });
      const res = await gen.generate(WITH_CODES, VARIATION);
      expect(res).toEqual({ ok: true, value: '味が良い店' });
      expect(calls).toHaveLength(1);
      expect(seen).toEqual([]);
    });

    it('作り直しが失敗したら初回の下書きを返す', async () => {
      const { client } = fakeClient([draftResponse('雰囲気が良い店'), { text: 'not json' }]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF, lexicon: LEXICON });
      const res = await gen.generate(WITH_CODES, VARIATION);
      expect(res).toEqual({ ok: true, value: '雰囲気が良い店' });
    });

    it('factualityCheck: false なら検証せず初回をそのまま返す（測定の独立性）', async () => {
      const { client, calls } = fakeClient([draftResponse('雰囲気が良い店')]);
      const gen = createDraftGenerator(client, {
        backoff: NOOP_BACKOFF,
        lexicon: LEXICON,
        factualityCheck: false,
      });
      const res = await gen.generate(WITH_CODES, VARIATION);
      expect(res).toEqual({ ok: true, value: '雰囲気が良い店' });
      expect(calls).toHaveLength(1);
    });

    it('unselectedAspectCodes を持たない素材では検証しない（旧 sessionToken からの復元）', async () => {
      const { client, calls } = fakeClient([draftResponse('雰囲気が良い店')]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF, lexicon: LEXICON });
      const res = await gen.generate(MATERIAL, VARIATION);
      expect(res).toEqual({ ok: true, value: '雰囲気が良い店' });
      expect(calls).toHaveLength(1);
    });
  });

  // Issue #413: 来店前の期待と「無かった」の断定も、未選択の観点と同じく事後検証で 1 回だけ作り直す。
  // どちらも語の形で決まり、誤検出が少ない（#415 の数え直しで約 230 文を読み 0 件）。再訪の意向と観点の属性は
  // 発生が多く（約 11%）、属性は言い換えとの境界が曖昧なので、作り直しの引き金にしない。
  describe('来店前の期待と「無かった」の断定の事後検証（Issue #413）', () => {
    // 観点を選んでいない素材（未選択の観点の検証が効かない形）。この軸だけで作り直しが起きることを確かめる。
    const PLAIN: DraftMaterial = { storeName: '店', star: 2, aspectLabels: [], concernLabels: ['量'] };

    it('来店前の期待を検出したら作り直し、解消した方を返す', async () => {
      const { client, calls } = fakeClient([
        draftResponse('量が少なく、期待していた水準には届きませんでした。'),
        draftResponse('量が少なく、満足できませんでした。'),
      ]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(PLAIN, VARIATION)).toEqual({ ok: true, value: '量が少なく、満足できませんでした。' });
      expect(calls).toHaveLength(2);
    });

    it('「無かった」の断定を検出したら作り直し、解消した方を返す', async () => {
      const { client, calls } = fakeClient([
        draftResponse('量が少なかったです。その他の点については特筆すべき事項はありません。'),
        draftResponse('量が少なく、満足できませんでした。'),
      ]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      expect(await gen.generate(PLAIN, VARIATION)).toEqual({ ok: true, value: '量が少なく、満足できませんでした。' });
      expect(calls).toHaveLength(2);
    });

    it('作り直しても残れば下書きを返しつつ、残った分類を通知する（未選択の観点の通知とは分ける）', async () => {
      const aspects: string[][] = [];
      const claims: string[][] = [];
      const { client, calls } = fakeClient([draftResponse('期待していた水準には届かず、気になった点は特にありませんでした。')]);
      const gen = createDraftGenerator(client, {
        backoff: NOOP_BACKOFF,
        onResidual: (codes) => aspects.push(codes),
        onClaimResidual: (categories) => claims.push(categories),
      });
      const res = await gen.generate(PLAIN, VARIATION);
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(aspects).toEqual([]);
      expect(claims).toEqual([['absence:concerns', 'expectation']]);
    });

    it('呼び出しごとの通知先を渡せば、生成器の既定より優先する', async () => {
      const fromOptions: string[][] = [];
      const fromRequest: string[][] = [];
      const { client } = fakeClient([draftResponse('期待していた水準には届きませんでした。')]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF, onClaimResidual: (c) => fromOptions.push(c) });
      await gen.generate(PLAIN, VARIATION, undefined, (c) => fromRequest.push(c));
      expect(fromOptions).toEqual([]);
      expect(fromRequest).toEqual([['expectation']]);
    });

    it('再訪の意向と観点の属性では作り直さない（引き金にしない分類）', async () => {
      const { client, calls } = fakeClient([draftResponse('落ち着いた雰囲気で、また機会があれば利用したいです。')]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      await gen.generate(PLAIN, VARIATION);
      expect(calls).toHaveLength(1);
    });

    it('客が一言に書いた事情は数えない（一言「期待していたほどではありませんでした」）', async () => {
      const { client, calls } = fakeClient([draftResponse('期待していたほどではありませんでした。')]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF });
      await gen.generate({ ...PLAIN, comment: '期待していたほどではありませんでした' }, VARIATION);
      expect(calls).toHaveLength(1);
    });

    it('factualityCheck: false なら、この軸も検証しない（eval の案A 単体の測定）', async () => {
      const { client, calls } = fakeClient([draftResponse('期待していた水準には届きませんでした。')]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF, factualityCheck: false });
      await gen.generate(PLAIN, VARIATION);
      expect(calls).toHaveLength(1);
    });

    it('未選択の観点とこの軸が同時に当たっても、作り直しは 1 回だけ', async () => {
      const { client, calls } = fakeClient([draftResponse('雰囲気が良く、期待以上でした。')]);
      const gen = createDraftGenerator(client, { backoff: NOOP_BACKOFF, lexicon: { atmosphere: ['雰囲気'] } });
      await gen.generate(
        { ...PLAIN, unselectedAspectLabels: ['雰囲気'], unselectedAspectCodes: ['atmosphere'] },
        VARIATION,
      );
      expect(calls).toHaveLength(2);
    });
  });
});

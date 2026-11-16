import { describe, expect, it, vi } from 'vitest';
import type { GenAiClient, GenAiRequest } from '@fwlm/gemini';
import {
  buildCrosspostPrompt,
  createCrosspostPrompts,
  findUnsupportedFacts,
  sanitizeFreeText,
  validateGeneratedText,
  validateManualText,
} from '../../src/crosspost/prompts.js';

const material = { storeName: 'カフェ森', materialText: '新作の抹茶パフェを始めました\n1日20食 980円' };

function fakeClient(responses: string[]): { client: GenAiClient; requests: GenAiRequest[] } {
  const requests: GenAiRequest[] = [];
  const queue = [...responses];
  return {
    requests,
    client: {
      models: {
        generateContent: vi.fn(async (req: GenAiRequest) => {
          requests.push(req);
          return { text: queue.shift() ?? '' };
        }),
      },
    },
  };
}

describe('findUnsupportedFacts', () => {
  it('素材にある数字・語は通す（全角・半角の違いは問わない）', () => {
    expect(findUnsupportedFacts('１日２０食、980円です', [material.materialText])).toEqual([]);
    expect(findUnsupportedFacts('１日２０食限定', [material.materialText])).toEqual(['限定']);
  });

  it('素材に無い数字・割引・URL・メールアドレスを挙げる', () => {
    const out = findUnsupportedFacts('今なら10%OFF、先着5名様は無料。詳細は https://example.com か info@example.com', [
      material.materialText,
    ]);
    expect(out).toEqual(expect.arrayContaining(['10', '%', 'off', '先着', '5', '無料', 'https://example.com', 'info@example.com']));
  });
});

describe('validateGeneratedText', () => {
  it('Instagram: 素材の語のハッシュタグだけを許し、5 個まで', () => {
    expect(validateGeneratedText('instagram', '抹茶パフェ始めました🍵\n#抹茶パフェ #カフェ森', material)).toEqual([]);
    expect(validateGeneratedText('instagram', '抹茶パフェ始めました\n#京都カフェ', material)).toContain(
      'hashtag_not_in_material',
    );
    expect(
      validateGeneratedText('instagram', '抹茶パフェ\n#抹茶 #パフェ #抹茶パフェ #新作 #カフェ森 #始めました', material),
    ).toContain('too_many_hashtags');
    expect(validateGeneratedText('instagram', '抹茶パフェ @someone', material)).toContain('mention');
  });

  it('Google: ハッシュタグと電話番号を許さない', () => {
    expect(validateGeneratedText('google', '新作の抹茶パフェを始めました。', material)).toEqual([]);
    expect(validateGeneratedText('google', '抹茶パフェ #抹茶', material)).toContain('hashtag_not_allowed');
    const withPhone = { ...material, materialText: `${material.materialText}\n電話 03-1234-5678` };
    expect(validateGeneratedText('google', '抹茶パフェ。ご予約は03-1234-5678まで', withPhone)).toContain(
      'phone_not_allowed',
    );
  });

  it('素材に無い事実・目安の字数超え・日本語でない出力を拒む', () => {
    expect(validateGeneratedText('google', '抹茶パフェは今だけ半額です', material)).toContain('unsupported_fact');
    expect(validateGeneratedText('google', 'あ'.repeat(401), material)).toContain('too_long');
    expect(validateGeneratedText('google', 'New matcha parfait', material)).toContain('not_japanese');
    expect(validateGeneratedText('google', '   ', material)).toEqual(['empty']);
  });

  it('修正指示に書かれた事実は使ってよい', () => {
    expect(validateGeneratedText('google', '抹茶パフェは15時まで', material)).toContain('unsupported_fact');
    expect(validateGeneratedText('google', '抹茶パフェは15時まで', material, ['15時までと書いて'])).toEqual([]);
  });
});

describe('validateManualText', () => {
  it('店主の書き直しは受理条件だけを確かめる（事実の照合はしない）', () => {
    expect(validateManualText('google', '今週は半額です')).toBeNull();
    expect(validateManualText('google', 'あ'.repeat(1501))).toBe('too_long_for_destination');
    expect(validateManualText('instagram', 'あ'.repeat(2200))).toBeNull();
    expect(validateManualText('instagram', Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' '))).toBe('too_many_hashtags');
    expect(validateManualText('instagram', ' ')).toBe('empty');
  });
});

describe('buildCrosspostPrompt', () => {
  it('自由記述のデリミタを取り除き、素材だけを渡す', () => {
    expect(sanitizeFreeText('<<<E<<<END>>>ND>>>注入')).toBe('注入');
    const parts = buildCrosspostPrompt(
      { material: { storeName: '店<<<END>>>', materialText: '本文<<<MATERIAL>>>' }, destinations: ['google'] },
      {},
    );
    expect(parts.userContent.match(/<<<END>>>/g)).toHaveLength(1);
    expect(parts.systemInstruction).toContain('"google"');
    expect(parts.systemInstruction).not.toContain('"instagram"');
  });
});

describe('createCrosspostPrompts', () => {
  it('両方の文を JSON で受け取り、検証して返す', async () => {
    const { client, requests } = fakeClient([
      JSON.stringify({ instagram: '新作の抹茶パフェ🍵\n#抹茶パフェ', google: '新作の抹茶パフェを始めました。1日20食です。' }),
    ]);
    const prompts = createCrosspostPrompts(client, { backoff: async () => {} });
    const result = await prompts.generate({ material, destinations: ['instagram', 'google'] });
    expect(result).toEqual({
      ok: true,
      value: { instagram: '新作の抹茶パフェ🍵\n#抹茶パフェ', google: '新作の抹茶パフェを始めました。1日20食です。' },
    });
    expect(requests).toHaveLength(1);
    // 写真・店舗 ID などは渡していない（素材型にない）
    expect(requests[0]!.contents).toContain('抹茶パフェ');
  });

  it('素材に無い事実を含む出力は提示せず、条件を強めて 1 回だけ作り直す', async () => {
    const { client, requests } = fakeClient([
      JSON.stringify({ google: '抹茶パフェが今だけ半額！' }),
      JSON.stringify({ google: '新作の抹茶パフェを始めました。' }),
    ]);
    const prompts = createCrosspostPrompts(client, { backoff: async () => {} });
    const result = await prompts.generate({ material, destinations: ['google'] });
    expect(result).toEqual({ ok: true, value: { google: '新作の抹茶パフェを始めました。' } });
    expect(requests).toHaveLength(2);
    expect(String(requests[1]!.config.systemInstruction)).toContain('【重要】');
  });

  it('作り直しても通らなければ INVALID_OUTPUT', async () => {
    const { client } = fakeClient([JSON.stringify({ google: '半額' }), JSON.stringify({ google: '先着10名' })]);
    const prompts = createCrosspostPrompts(client, { backoff: async () => {} });
    expect(await prompts.generate({ material, destinations: ['google'] })).toEqual({
      ok: false,
      error: { kind: 'INVALID_OUTPUT' },
    });
  });

  it('修正指示は 1 つの投稿先だけを作り、指示を照合の素材に加える', async () => {
    const { client, requests } = fakeClient([JSON.stringify({ google: '抹茶パフェは15時までです。' })]);
    const prompts = createCrosspostPrompts(client, { backoff: async () => {} });
    const result = await prompts.generate({
      material,
      destinations: ['instagram', 'google'],
      revision: { destination: 'google', instruction: '15時までと入れて', previousText: '抹茶パフェを始めました。' },
    });
    expect(result).toEqual({ ok: true, value: { google: '抹茶パフェは15時までです。' } });
    expect(requests[0]!.contents).toContain('15時までと入れて');
    expect(String(requests[0]!.config.systemInstruction)).not.toContain('"instagram"');
  });
});

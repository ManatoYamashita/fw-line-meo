import { describe, it, expect } from 'vitest';
import { normalizeTargetLabel } from '@fwlm/db';
import type { StructuredDraftMaterial } from '../src/lib/draft/structured-draft';
import { readLegacyLexicons, readStructuredGateLexicon, runtimeViolations } from '../src/lib/draft/structured/gate';
import { gateInputOf } from '../src/lib/draft/structured/realizer';
import lexiconRaw from '../src/lib/draft/structured/lexicon.json';

// Issue #480 の判断材料: 評価・推奨・再訪の語を含む「正式なメニュー名」を、今の 2 層がどう扱うかを固定する。
// 振る舞いは変えない（案 A＝現行のまま）。案を採ったときに、どのケースの期待が変わるかをこのファイルで見る。
//
// 1. 登録（@fwlm/db の normalizeTargetLabel）: 名前に語が入れば LABEL_EVALUATIVE で止める
// 2. 事後検証（runtime hard gate）: 規則より前に登録された名前でも、名前の中の語は検査から外さない
//
// 2 があるので、登録の規則だけを緩めると、その名前を書いた下書きは毎回失格になり、3 回の試行の後に
// 生成の失敗になる。案 B（正式な商品名として扱う）は、登録とゲートの両方を同時に見直す必要がある。

const LEX = readStructuredGateLexicon(lexiconRaw);
const LEGACY = readLegacyLexicons();
const TARGET = 'a4800000-0000-4000-8000-0000000000a1';

// Issue #480 が「あり得る正式名」として挙げた 5 件と、今それぞれを止めている語の分類。
// 「次回限定ランチ」の「次回」は再訪の意向ではないが、revisit の語彙に当たる（誤拒否の実例）。
const OFFICIAL_LIKE_NAMES = [
  { label: '絶品餃子', kind: 'intensity', plain: '餃子' },
  { label: '極上プリン', kind: 'intensity', plain: 'プリン' },
  { label: 'おすすめセット', kind: 'recommendation', plain: 'セット' },
  { label: '最高峰コース', kind: 'intensity', plain: 'コース' },
  { label: '次回限定ランチ', kind: 'revisit', plain: 'ランチ' },
] as const;

function chosen(label: string, polarity: 'positive' | 'concern'): StructuredDraftMaterial {
  return {
    storeName: '居酒屋 テスト',
    surveyRevision: 1,
    star: polarity === 'positive' ? 5 : 2,
    selections: [{ polarity, categoryCode: 'food', categoryLabel: '料理', targetId: TARGET, targetLabel: label, facets: [{ code: 'taste', label: '味' }] }],
    unselectedTargets: [],
  };
}

const runtime = (m: StructuredDraftMaterial, draft: string) => runtimeViolations(gateInputOf(m), draft, LEX, LEGACY);
const positiveDraft = (label: string) => `${label}の味が良かったです。`;
const concernDraft = (label: string) => `${label}の味が気になりました。`;

describe('Issue #480: 正式名としてあり得る名前は、今は登録で止まる（案 A）', () => {
  it.each(OFFICIAL_LIKE_NAMES)('$label', ({ label }) => {
    expect(normalizeTargetLabel(label)).toEqual({ ok: false, error: 'LABEL_EVALUATIVE' });
  });

  it('対照: 語を除いた名前は登録できる', () => {
    for (const { plain } of OFFICIAL_LIKE_NAMES) expect(normalizeTargetLabel(plain), plain).toEqual({ ok: true, value: plain });
  });

  it('料理名を装った口コミへの誘導（どの案でも止める）', () => {
    expect(normalizeTargetLabel('この店は最高です。皆さんも行ってみて')).toEqual({ ok: false, error: 'LABEL_EVALUATIVE' });
  });
});

describe('Issue #480: 規則より前に登録された同じ名前は、客が選んでも事後検証で止まる', () => {
  it.each(OFFICIAL_LIKE_NAMES)('良かったところで選んだ $label', ({ label, kind }) => {
    expect(runtime(chosen(label, 'positive'), positiveDraft(label))).toContain(kind);
  });

  // 低い星で「気になったところ」に選んでも、名前の中の語は本人の高評価として通さない。
  it.each(OFFICIAL_LIKE_NAMES)('気になったところで選んだ $label', ({ label, kind }) => {
    expect(runtime(chosen(label, 'concern'), concernDraft(label))).toContain(kind);
  });

  it('対照: 語を除いた名前なら、同じ形の下書きは良かったところ・気になったところとも通る', () => {
    for (const { plain } of OFFICIAL_LIKE_NAMES) {
      expect(runtime(chosen(plain, 'positive'), positiveDraft(plain)), plain).toEqual([]);
      expect(runtime(chosen(plain, 'concern'), concernDraft(plain)), plain).toEqual([]);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { TARGET_LABEL_EVALUATIVE_PATTERNS } from '@fwlm/db/survey-settings-rules';
import lexiconRaw from '../src/lib/draft/structured/lexicon.json';

// Target 名の登録の規則（@fwlm/db の TARGET_LABEL_EVALUATIVE_PATTERNS）と、下書きの事実チェックの語彙
// （lib/draft/structured/lexicon.json）が同じ語を持つことの機械強制（PR #443 のレビュー対応）。
//
// 登録の規則は client（store-detail の設定画面）と server（@fwlm/db・store-detail の API）が使うので @fwlm/db に
// 置き、survey-web の語彙を参照しない（依存の向きは survey-web → @fwlm/db だけ）。片方だけに語を足すと、
// 登録できるのに下書きで止まる名前（毎回作り直しになる）か、登録で止めない語が名前の中で検査から外れる経路が生まれる。

describe('Target 名の登録の規則と下書きの事実チェックの語彙は一致する', () => {
  const lexicon = lexiconRaw as unknown as Record<string, readonly string[]>;
  for (const key of ['intensity', 'recommendation', 'revisit'] as const) {
    it(key, () => {
      expect([...TARGET_LABEL_EVALUATIVE_PATTERNS[key]].sort()).toEqual([...lexicon[key]!].sort());
    });
  }
});

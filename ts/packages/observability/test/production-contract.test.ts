import { describe, expect, it, vi } from 'vitest';

import { writeStructuredLog } from '../src/sink.js';

/**
 * 本番で**稼働中の集計指標**が読む契約を固定する（Issue #228 タスク 5.2）。
 *
 * `infra/modules/guardrails/main.tf` の `survey_funnel` は
 *   - `jsonPayload.event = "survey_page_viewed"` / `"survey_response_submitted"` で絞り込み
 *   - `EXTRACT(jsonPayload.storeId)` でラベルを取り出す
 * という形で本番のログを読んでいる。**この形が崩れると指標は静かに 0 になる**。
 * 指標は作成時点から数え始めるため、壊れた期間のデータは後から復元できない。
 *
 * 事象名そのものが実装に在ることは `scripts/check-log-field-binding.sh` が正典との
 * 両方向照合で守る。本ファイルが守るのは**出力の構造**である。すなわち、集約基盤が
 * `jsonPayload` として読む位置に、指標が期待する名前で値が現れること。
 */

function captureLine(level: 'info' | 'warn' | 'error', run: () => void): Record<string, unknown> {
  const spy = vi.spyOn(console, level).mockImplementation(() => undefined);
  try {
    run();
    return JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
  } finally {
    spy.mockRestore();
  }
}

describe('本番の集計指標が読む契約', () => {
  // survey_funnel の filter が絞り込む 2 事象。
  for (const event of ['survey_page_viewed', 'survey_response_submitted']) {
    it(`${event} は event 項目として出る（指標の filter が読む位置）`, () => {
      const record = captureLine('info', () => {
        writeStructuredLog('info', event, { storeId: 'store-1' });
      });
      expect(record.event).toBe(event);
    });
  }

  it('storeId は指標のラベル抽出が読む名前で出る', () => {
    // EXTRACT(jsonPayload.storeId) が読む。camelCase を変えると抽出が空になる。
    const record = captureLine('info', () => {
      writeStructuredLog('info', 'survey_page_viewed', { storeId: 'store-1' });
    });
    expect(record.storeId).toBe('store-1');
    expect(record).not.toHaveProperty('store_id');
  });

  it('重大度は指標の filter を壊さない位置に出る', () => {
    // 指標は event だけで絞る。重大度の項目が増えても filter は影響を受けないが、
    // event と storeId を押し出してはならない。
    const record = captureLine('warn', () => {
      writeStructuredLog('warn', 'survey_page_viewed', { storeId: 'store-1' });
    });
    expect(record.severity).toBe('WARNING');
    expect(record.event).toBe('survey_page_viewed');
    expect(record.storeId).toBe('store-1');
  });

  it('来店客に紐づく値は出力に現れない', () => {
    // 指標は店舗単位で数える。客を横断して同一人物と判定できる値が混ざってはならない。
    const record = captureLine('info', () => {
      writeStructuredLog('info', 'survey_response_submitted', { storeId: 'store-1' });
    });
    expect(Object.keys(record).sort()).toEqual(['event', 'severity', 'storeId']);
  });
});

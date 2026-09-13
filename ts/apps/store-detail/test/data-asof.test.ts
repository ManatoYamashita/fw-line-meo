// 基準日（asOf）の既定値が JST の暦日であることの検証（Issue #268）。
//
// 日次バッチ（Go）は JST の暦日で daily_summaries.summary_date / rating_snapshots.captured_on を
// 書く（go/internal/batch/run.go の jstDateAsUTC）。読み取り側の基準日が UTC の日付だと、
// 0:00〜9:00 JST のあいだは当日の行が `summary_date = $2` と `captured_on <= $2` の両方から外れ、
// 前日分が「今日のポジション」として表示される。朝 7:00 の Flex から「詳細を見る」を開く導線が
// ちょうどこの時間帯に当たる。
//
// DB には触れない。偽の pool で発行された SQL のパラメータ（$2 = 基準日）だけを見る。
// 30 日窓の境界そのもの（asOf を注入した場合）は data.db.test.ts が実 DB で固定している。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@fwlm/db';

import { queryStoreDetail } from '../lib/data';

const STORE_ID = '11111111-1111-1111-1111-111111111111';

interface RecordedQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

function recordingPool(): { readonly pool: Queryable; readonly calls: RecordedQuery[] } {
  const calls: RecordedQuery[] = [];
  const pool = {
    query: vi.fn(async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Queryable;
  return { pool, calls };
}

/** 発行された 2 本（当日サマリー・推移）の基準日パラメータを取り出す。 */
async function asOfParamsAt(instant: string): Promise<readonly unknown[]> {
  vi.setSystemTime(new Date(instant));
  const { pool, calls } = recordingPool();
  await queryStoreDetail(pool, STORE_ID);
  // 2 本とも発行されたことを先に固定する（0 本なら下の map が空配列を返し、何も検査しない）。
  expect(calls).toHaveLength(2);
  return calls.map((call) => call.params[1]);
}

describe('queryStoreDetail の基準日の既定値（Issue #268）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    // [UTC の瞬間, 期待する JST の暦日, 説明]
    ['2026-09-12T22:30:00.000Z', '2026-09-13', '07:30 JST（朝の Flex から開く時間帯）'],
    ['2026-09-12T23:59:59.999Z', '2026-09-13', '08:59:59 JST（UTC ではまだ前日の最後の瞬間）'],
    ['2026-09-13T00:00:00.000Z', '2026-09-13', '09:00 JST（UTC の日付も当日へ切り替わる瞬間）'],
    ['2026-09-12T15:00:00.000Z', '2026-09-13', '00:00 JST（JST の日付が切り替わる瞬間）'],
    ['2026-09-12T14:59:59.999Z', '2026-09-12', '23:59:59 JST（JST ではまだ前日）'],
  ])('%s は JST の暦日 %s を基準日にする（%s）', async (instant, expected) => {
    const params = await asOfParamsAt(instant);
    expect(params).toEqual([expected, expected]);
  });

  it('asOf を注入したときは既定値を使わない（DB テストの境界固定の口を保つ）', async () => {
    vi.setSystemTime(new Date('2026-09-12T22:30:00.000Z'));
    const { pool, calls } = recordingPool();
    await queryStoreDetail(pool, STORE_ID, { asOf: '2026-08-30' });
    expect(calls.map((call) => call.params[1])).toEqual(['2026-08-30', '2026-08-30']);
  });
});

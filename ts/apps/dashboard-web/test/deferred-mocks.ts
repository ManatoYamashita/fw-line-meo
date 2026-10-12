// 取得のモックを「実時間で遅れて解決する」形へ包む（Issue #298）。
//
// `mockResolvedValue` のモックはほぼ即座に解決するので、画面は取得の結果をすぐに描く。
// すると「取得で中身が増える要素へ、到着を待たずに触る」検査が手元では通ってしまい、
// 負荷の高い CI でだけ落ちる（#296 の invite-codes で顕在化した）。
// 解決を遅らせると、取得の前の画面に触る検査が手元でも毎回赤になる。
//
// **遅延はマクロタスク 1 つ（setTimeout(0)）では足りない。** Testing Library の `findBy*` は
// 終わるたびに setTimeout(0) を 1 つ挟んで保留中の作業を流すので、`findBy` を 1 回経るだけで
// 取得が解決してしまう。導入時（#298）に、修正前の検査へ遅延を変えて当てた赤の件数:
// 0ms（setTimeout のみ）3 件／1ms 3 件／5ms 8〜9 件（揺れる）／10ms 10 件／30ms 12 件（2 回とも）。
// 30ms は、決定的にすべてを捕まえた最小の値である。100ms・300ms でも修正後は全件緑だった
// （検査が遅延の長さに依存していない）。費用は dashboard-web 全体で 2 秒弱（遅延 494 回）。
//
// 包むのはモジュールの輸出だけで、`api.getX` の vi.fn はそのまま残す。呼び出しの記録と
// `mockReset` / `mockResolvedValue` は従来どおり vi.fn に対して効き、入れ子の beforeEach で
// モックを作り直しても網は外れない。解決しない約束（送信中に留める検査）は包んでも解決しない。
import { fireEvent, within } from '@testing-library/react';
import { expect } from 'vitest';

// 計測用に上書きできる（例: DASHBOARD_TEST_FETCH_DEFER_MS=300 で検査が遅延の長さに依存しないかを見る）。
const DEFER_MS = Number(process.env.DASHBOARD_TEST_FETCH_DEFER_MS ?? 30);

function deferThenable(value: PromiseLike<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    value.then(
      (resolved) => setTimeout(() => resolve(resolved), DEFER_MS),
      (error: unknown) => setTimeout(() => reject(error), DEFER_MS),
    );
  });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * `vi.mock('../src/lib/api', async () => (await import('./deferred-mocks')).deferResolution(api))`
 * の形で使う。関数でない輸出はそのまま渡す。
 */
export function deferResolution<T extends Record<string, unknown>>(module: T): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(module)) {
    wrapped[name] =
      typeof member === 'function'
        ? (...args: unknown[]) => {
            const result: unknown = (member as (...a: unknown[]) => unknown)(...args);
            return isThenable(result) ? deferThenable(result) : result;
          }
        : member;
  }
  return wrapped as T;
}

/**
 * 非同期に届く選択肢を選ぶ。選択肢の到着を待ってから値を変え、変更が効いたことを表明する。
 *
 * DOM の select は存在しない値を受け付けず、`fireEvent.change` は黙って空振りする。
 * 空振りしたまま先へ進むと、後続の `findBy*` は目的の分岐ではない画面を見続けて
 * タイムアウトし、失敗時の HTML には（その頃には届いた）選択肢が写るので原因が見えない。
 * 値の表明は、この空振りをその場で理由つきで落とすためにある。
 */
export async function chooseOption(
  select: HTMLElement,
  optionName: string,
): Promise<HTMLSelectElement> {
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`chooseOption: 選択要素ではない（${select.tagName}）`);
  }
  const option = await within(select).findByRole<HTMLOptionElement>('option', { name: optionName });
  fireEvent.change(select, { target: { value: option.value } });
  expect(select.value, `選択肢「${optionName}」への変更が効いていない`).toBe(option.value);
  return select;
}

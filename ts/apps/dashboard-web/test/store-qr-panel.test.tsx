// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

import { buttonVariants } from '@fwlm/ui/components/button';
import { cn } from '@fwlm/ui/lib/utils';

import type { ApiResult, BinaryPayload } from '../src/lib/api';
import {
  POSTER_CAUTION,
  POSTER_HOWTO,
  POSTER_INVITATION,
  PROHIBITED_EXAMPLES,
} from '../src/lib/qr-poster-text';
import { settleEffects } from './focus-observation';

// api.ts は './firebase' を取り込むため、モジュールごと差し替えて実 SDK を発火させない
// （stores-page.test.tsx と同規約）。取得手続きは props で注入する。
vi.mock('../src/lib/api', () => ({ getStoreQr: vi.fn() }));

import { StoreQrPanel } from '../src/components/store-qr-panel';

const STORE_ID = '11111111-2222-3333-4444-555555555555';
const STORE_NAME = '炭火焼肉 やました';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

// jsdom には object URL を作る手段が無いため差し込む（実装側に抽象は作らない）。
const createObjectURL = vi.fn(() => 'blob:mock-url');
const revokeObjectURL = vi.fn();

function okPayload(): ApiResult<BinaryPayload> {
  return { ok: true, value: { bytes: PNG_BYTES, contentType: 'image/png' } };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
});

afterEach(cleanup);

describe('StoreQrPanel: 取得・表示・保存', () => {
  it('取得成功で画像と保存リンクが現れ、代替テキストと保存名に店名が入る（2.1, 6.4）', async () => {
    const fetchQr = vi.fn().mockResolvedValue(okPayload());
    render(
      <StoreQrPanel
        storeId={STORE_ID}
        storeName={STORE_NAME}
        onClose={vi.fn()}
        fetchQr={fetchQr}
      />,
    );

    const image = await screen.findByRole('img');
    expect(image.getAttribute('alt')).toContain(STORE_NAME);
    expect(image.getAttribute('src')).toBe('blob:mock-url');

    const link = screen.getByRole('link', { name: new RegExp(STORE_NAME) });
    expect(link.getAttribute('download')).toContain(STORE_NAME);
    expect(link.getAttribute('download')?.endsWith('.png')).toBe(true);
    expect(link.getAttribute('href')).toBe('blob:mock-url');
  });

  it('保存は実際のリンク要素として描画する（6.1）', async () => {
    const fetchQr = vi.fn().mockResolvedValue(okPayload());
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    const link = await screen.findByRole('link', { name: new RegExp(STORE_NAME) });
    expect(link.tagName).toBe('A');
  });

  // 部品の見た目を借りるときは `cn()` を通す（Issue #208）。
  //
  // `buttonVariants()` を裸で呼ぶと、基底の `border-transparent` と outline 変種の `border-input`
  // が **両方 class に残る**。詳細度が同じため生成 CSS の順序で `border-transparent` が勝ち、
  // 実描画で枠が透明になる。`Button` 部品は `cn()`（tailwind-merge）を通しており競合を後勝ちで
  // 解決するので、部品と裸呼びで**見た目だけが食い違う**。寸法も角丸も文字色も一致するため、
  // 実描画の枠を測らない限り気づけない。
  //
  // **期待値は「面が使うべき式」から導く。** 裸の `buttonVariants()` から導くと、面と期待値が
  // 同じ壊れ方をして緑のまま固定される（PR #200 の survey-web で実際に踏んだ形）。
  it('保存リンクが借りる見た目に、基底の透明枠が残っていない（Issue #208）', async () => {
    const fetchQr = vi.fn().mockResolvedValue(okPayload());
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    const link = await screen.findByRole('link', { name: new RegExp(STORE_NAME) });
    const classes = link.getAttribute('class') ?? '';
    expect(classes, '保存リンクが class を持たない（見た目を借りていない）').not.toBe('');

    expect(
      classes.split(/\s+/),
      '基底の border-transparent が残っている。cn() を通していないため outline 変種の枠が' +
        '実描画で透明になり、押せることが視覚的に伝わらない',
    ).not.toContain('border-transparent');

    expect(
      classes,
      '保存リンクの見た目が押しボタンの算出結果と一致しない',
    ).toBe(cn(buttonVariants({ variant: 'outline', size: 'sm' })));
  });

  it('取得中は処理中であることを示し、保存操作を出さない（2.2）', async () => {
    const pending = deferred<ApiResult<BinaryPayload>>();
    const fetchQr = vi.fn().mockReturnValue(pending.promise);
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    expect(screen.getByRole('status').textContent).toContain('生成');
    expect(screen.queryByRole('link')).toBeNull();
    expect(fetchQr).toHaveBeenCalledTimes(1);

    pending.resolve(okPayload());
    await screen.findByRole('img');
  });

  it('取得成功を支援技術へ通知する（6.2）', async () => {
    const fetchQr = vi.fn().mockResolvedValue(okPayload());
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('img');
    expect(screen.getByRole('status').textContent).toContain(STORE_NAME);
  });

  it('保存操作は新たな取得を発生させない（2.3）', async () => {
    const fetchQr = vi.fn().mockResolvedValue(okPayload());
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    const link = await screen.findByRole('link', { name: new RegExp(STORE_NAME) });
    fireEvent.click(link);

    expect(fetchQr).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('アンマウントで表示資源を解放する（2.8, 5.3）', async () => {
    const fetchQr = vi.fn().mockResolvedValue(okPayload());
    const { unmount } = render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('img');
    expect(revokeObjectURL).not.toHaveBeenCalled();

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('店舗あたり単一の QR のみを扱う（5.4）', async () => {
    const fetchQr = vi.fn().mockResolvedValue(okPayload());
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('img');
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('閉じる操作を提示し、押すと呼び出し側へ通知する（2.8）', async () => {
    const onClose = vi.fn();
    const fetchQr = vi.fn().mockResolvedValue(okPayload());
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={onClose} fetchQr={fetchQr} />,
    );

    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: /閉じる/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('取得完了前にアンマウントされた場合は資源を作らない', async () => {
    const pending = deferred<ApiResult<BinaryPayload>>();
    const fetchQr = vi.fn().mockReturnValue(pending.promise);
    const { unmount } = render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    unmount();
    pending.resolve(okPayload());
    await waitFor(() => expect(fetchQr).toHaveBeenCalledTimes(1));
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

function errorResult(code: string, message: string): ApiResult<BinaryPayload> {
  return { ok: false, code, message };
}

function alertText(): string {
  return screen.getByRole('alert').textContent ?? '';
}

describe('StoreQrPanel: 失敗表現と再試行', () => {
  it('失敗を支援技術へ assertive に通知し、画像を出さない（4.5, 6.2）', async () => {
    const fetchQr = vi.fn().mockResolvedValue(errorResult('network', 'ネットワークエラー'));
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('権限不足と対象不在を同一の文言で提示する（4.1）', async () => {
    const forbidden = vi.fn().mockResolvedValue(errorResult('FORBIDDEN', 'この店舗へのアクセス権がありません'));
    const { unmount } = render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={forbidden} />,
    );
    await screen.findByRole('alert');
    const forbiddenText = alertText();
    unmount();

    const notFound = vi.fn().mockResolvedValue(errorResult('NOT_FOUND', '店舗が見つかりません'));
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={notFound} />,
    );
    await screen.findByRole('alert');

    expect(alertText()).toBe(forbiddenText);
  });

  it('サーバが返した文言をそのまま画面へ出さない（4.1）', async () => {
    const fetchQr = vi.fn().mockResolvedValue(errorResult('FORBIDDEN', 'この店舗へのアクセス権がありません'));
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain('この店舗へのアクセス権がありません');
  });

  it('認証切れは再度のログインが必要である旨を示す（4.2）', async () => {
    const fetchQr = vi.fn().mockResolvedValue(errorResult('UNAUTHENTICATED', 'ログインが必要です'));
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    expect(alertText()).toContain('ログイン');
  });

  it('場所の未確定は確定が先に必要である旨を示す（3.3）', async () => {
    const fetchQr = vi
      .fn()
      .mockResolvedValue(errorResult('PLACE_NOT_CONFIRMED', '店舗の場所が未確定です。先に確定してください'));
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    expect(alertText()).toContain('確定');
  });

  it.each([
    ['network'],
    ['http_500'],
    ['empty_response'],
    ['SOMETHING_UNKNOWN'],
  ])('%s は再試行できる一般障害として提示する（4.3）', async (code) => {
    const fetchQr = vi.fn().mockResolvedValue(errorResult(code, 'サーバ側の文言'));
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    expect(alertText()).toContain('再試行');
  });

  it('未確定・認証切れ・通信障害を区別して提示する（3.3, 4.2, 4.3）', async () => {
    const texts: string[] = [];
    for (const code of ['PLACE_NOT_CONFIRMED', 'UNAUTHENTICATED', 'network']) {
      const fetchQr = vi.fn().mockResolvedValue(errorResult(code, 'サーバ側の文言'));
      const { unmount } = render(
        <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
      );
      await screen.findByRole('alert');
      texts.push(alertText());
      unmount();
    }

    expect(new Set(texts).size).toBe(3);
  });

  it('再試行で取得が 1 回だけ追加で走り、成功すれば画像が現れる（4.3, 4.4）', async () => {
    const fetchQr = vi
      .fn()
      .mockResolvedValueOnce(errorResult('network', 'ネットワークエラー'))
      .mockResolvedValueOnce(okPayload());
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    expect(fetchQr).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /再試行/ }));

    await screen.findByRole('img');
    expect(fetchQr).toHaveBeenCalledTimes(2);
  });

  it('失敗しても閉じる操作は使える（4.4）', async () => {
    const onClose = vi.fn();
    const fetchQr = vi.fn().mockResolvedValue(errorResult('network', 'ネットワークエラー'));
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={onClose} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /閉じる/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('StoreQrPanel: 失敗経路の堅牢性', () => {
  it.each([['constructor'], ['toString'], ['hasOwnProperty']])(
    'Object.prototype 由来の名前を持つ code（%s）でも空の文言を描画しない',
    async (code) => {
      const fetchQr = vi.fn().mockResolvedValue(errorResult(code, 'サーバ側の文言'));
      render(
        <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
      );

      await screen.findByRole('alert');
      // 未知の code と同じ「再試行できる一般障害」として扱われること。
      expect(alertText()).toContain('再試行');
      expect(alertText().length).toBeGreaterThan(0);
    },
  );

  it('取得手続きが例外を投げても loading のまま固着せず再試行できる（4.3）', async () => {
    const fetchQr = vi.fn().mockRejectedValue(new Error('boom'));
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: /再試行/ })).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('取得後に表示資源の生成が失敗しても loading のまま固着しない（4.3）', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      value: () => {
        throw new Error('object URL unavailable');
      },
      configurable: true,
    });
    const fetchQr = vi.fn().mockResolvedValue(okPayload());
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: /再試行/ })).toBeTruthy();
  });
});

// 再試行の押下で焦点が失われないことの固定（Requirement 6.1 後段）。
//
// 押下元が DOM から外れると、ブラウザは焦点を body へ移す。body には焦点指標が無いため
// 「現在の焦点がどこにあるかを視覚的に判別できる状態」が壊れ、キーボード利用者は一覧の
// 先頭からたどり直すことになる。閉じる操作については一覧側（StoresPage）が焦点を戻して
// いるが、再試行は同じ形の欠陥を残していた。
describe('StoreQrPanel: 焦点の引き取り', () => {
  /** 1 回失敗させたあと、2 回目の応答を呼び出し側から制御できる取得手続きを作る。 */
  function failThenControlled(): {
    fetchQr: ReturnType<typeof vi.fn>;
    resolveSecond: (value: ApiResult<BinaryPayload>) => void;
  } {
    const pending = deferred<ApiResult<BinaryPayload>>();
    const fetchQr = vi
      .fn()
      .mockResolvedValueOnce(errorResult('network', 'ネットワークエラー'))
      .mockReturnValueOnce(pending.promise);
    return { fetchQr, resolveSecond: pending.resolve };
  }

  it('再取得の間も焦点が再試行操作に残る（6.1）', async () => {
    const { fetchQr, resolveSecond } = failThenControlled();
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    screen.getByRole('button', { name: /再試行/ }).focus();
    fireEvent.click(screen.getByRole('button', { name: /再試行/ }));

    // 失敗表示が消える＝取得中へ移った時点で、押下元は生きていなければならない。
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /再試行/ }));

    resolveSecond(okPayload());
    await screen.findByRole('img');
  });

  it('再試行が再び失敗しても焦点が再試行操作に残る（6.1）', async () => {
    const fetchQr = vi
      .fn()
      .mockResolvedValueOnce(errorResult('network', '1 回目'))
      .mockResolvedValueOnce(errorResult('network', '2 回目'));
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    screen.getByRole('button', { name: /再試行/ }).focus();
    fireEvent.click(screen.getByRole('button', { name: /再試行/ }));

    await waitFor(() => expect(fetchQr).toHaveBeenCalledTimes(2));
    await screen.findByRole('alert');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /再試行/ }));
  });

  it('再試行が成功したとき焦点をパネル内の保存操作へ引き取る（6.1）', async () => {
    const fetchQr = vi
      .fn()
      .mockResolvedValueOnce(errorResult('network', 'ネットワークエラー'))
      .mockResolvedValueOnce(okPayload());
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    screen.getByRole('button', { name: /再試行/ }).focus();
    fireEvent.click(screen.getByRole('button', { name: /再試行/ }));

    const link = await screen.findByRole('link', { name: new RegExp(STORE_NAME) });
    // **収束を待つ。** 焦点の引き取りは passive effect なので、リンクが DOM に現れた時点では
    // まだ移っていないことがある（Issue #166・CI で偽の赤として実発生）。
    await waitFor(() => expect(document.activeElement).toBe(link));
  });

  it('再取得の間の再試行操作は押下を受け付けない状態として提示される（2.2, 6.1）', async () => {
    const { fetchQr, resolveSecond } = failThenControlled();
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /再試行/ }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

    const retry = screen.getByRole('button', { name: /再試行/ }) as HTMLButtonElement;
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    // 焦点を残すため native disabled 属性は付かない。したがって減光は data-disabled 側でしか
    // 届かない（この属性が消えると、押下不能なのに通常の見た目のまま残る）。
    expect(retry.hasAttribute('data-disabled')).toBe(true);
    expect(retry.disabled).toBe(false);

    resolveSecond(okPayload());
    await screen.findByRole('img');
  });

  it('再取得の間に再試行をもう一度押しても取得は増えない（2.2）', async () => {
    const { fetchQr, resolveSecond } = failThenControlled();
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /再試行/ }));
    await waitFor(() => expect(fetchQr).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: /再試行/ }));
    fireEvent.click(screen.getByRole('button', { name: /再試行/ }));
    expect(fetchQr).toHaveBeenCalledTimes(2);

    resolveSecond(okPayload());
    await screen.findByRole('img');
  });

  it('初回取得の間に焦点がどこにも無くなっても、成功時に焦点を奪わない（6.1）', async () => {
    const pending = deferred<ApiResult<BinaryPayload>>();
    const fetchQr = vi.fn().mockReturnValue(pending.promise);
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    // マウスで発行操作を押したあと余白を押すと、焦点は body へ落ちる。この焦点を壊したのは
    // 利用者であってパネルではないため、初回取得の成功で引き取ってはならない。
    // attempt === 0 の早期 return だけが担当する領域で、これを外すとここが赤くなる。
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    pending.resolve(okPayload());
    await screen.findByRole('img');
    // **待つのではなく観測点を確定させる。** waitFor は条件が最初から成立しているため即座に
    // 通ってしまい、effect が後から横取りしても緑を返す（Issue #166）。
    await settleEffects();
    expect(document.activeElement).toBe(document.body);
  });

  it('再取得の間に焦点を他の操作へ移していれば、成功時に焦点を奪わない（6.1）', async () => {
    const { fetchQr, resolveSecond } = failThenControlled();
    render(
      <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
    );

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /再試行/ }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

    const close = screen.getByRole('button', { name: /閉じる/ });
    close.focus();

    resolveSecond(okPayload());
    await screen.findByRole('img');
    await settleEffects();
    expect(document.activeElement).toBe(close);
  });
});

// ---- ここから Issue #179 が追加した検証（店頭掲示の文言・Requirement 7） ----

/** 印刷対象の領域。globals.css の @media print がこの印だけを紙に残す。 */
function printRegion(): HTMLElement {
  const region = document.querySelector('[data-print-region]');
  expect(region, '印刷対象の領域がありません').not.toBeNull();
  return region as HTMLElement;
}

async function renderReady(): Promise<void> {
  const fetchQr = vi.fn().mockResolvedValue(okPayload());
  render(
    <StoreQrPanel storeId={STORE_ID} storeName={STORE_NAME} onClose={vi.fn()} fetchQr={fetchQr} />,
  );
  await screen.findByRole('img');
}

describe('StoreQrPanel: 店頭掲示の文言（Requirement 7）', () => {
  it('掲示面に店名・依頼文・案内文が載り、すべて印刷対象の中にある', async () => {
    await renderReady();
    const region = printRegion();
    expect(region.textContent).toContain(STORE_NAME);
    expect(region.textContent).toContain(POSTER_INVITATION);
    expect(region.textContent).toContain(POSTER_HOWTO);
  });

  // **受入基準の番号を名前に足さない。** ここが測っているのは「掲示面を足しても画像が
  // 二重にならないこと」だけで、切替時の後始末（2.8）も取得回数（2.3）も踏んでいない。
  // それらは既存のケース（アンマウントで資源解放／保存が再取得を起こさない）が持っている。
  it('QR 画像は掲示面の中にあり、画面に 1 枚しか存在しない', async () => {
    await renderReady();
    const images = screen.getAllByRole('img');
    expect(images, '画像が 2 枚以上あります（掲示面と確認用が二重になっています）').toHaveLength(1);
    expect(printRegion().contains(images[0]!), 'QR 画像が印刷対象の外にあります').toBe(true);
  });

  it('**不可の例は印刷対象の外にある**（紙に刷ってはならない）', async () => {
    await renderReady();
    const region = printRegion();
    for (const example of PROHIBITED_EXAMPLES) {
      // 画面には出る（オーナー・代理店が見るべき情報である）。
      expect(screen.getByText(new RegExp(example.text)), `画面に出ていません: ${example.text}`).toBeDefined();
      // 紙には出ない。ここが破れると、この機能が防ごうとした違反そのものを製品が配ることになる。
      expect(
        region.textContent,
        `不可の例が印刷対象に含まれています（紙に刷られます）: ${example.text}`,
      ).not.toContain(example.text);
    }
    expect(region.textContent, '注意書きが印刷対象に含まれています').not.toContain(POSTER_CAUTION);
  });

  it('掲示物の印刷はブラウザの印刷機能を起動する（PDF を自前で組み立てない）', async () => {
    const print = vi.fn();
    Object.defineProperty(window, 'print', { value: print, configurable: true });
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${STORE_NAME} の掲示物を印刷`) }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('取得中と失敗時は掲示面も印刷操作も出さない（既定側の固定）', async () => {
    // 条件つきの形だけを assert すると「常に出す」改変が素通りする。両端を押さえる。
    const pending = deferred<ApiResult<BinaryPayload>>();
    render(
      <StoreQrPanel
        storeId={STORE_ID}
        storeName={STORE_NAME}
        onClose={vi.fn()}
        fetchQr={vi.fn().mockReturnValue(pending.promise)}
      />,
    );
    expect(document.querySelector('[data-print-region]'), '取得中に掲示面が出ています').toBeNull();
    expect(screen.queryByRole('button', { name: /掲示物を印刷/ })).toBeNull();

    pending.resolve({ ok: false, code: 'FORBIDDEN', message: 'ignored' });
    await screen.findByRole('alert');
    expect(document.querySelector('[data-print-region]'), '失敗時に掲示面が出ています').toBeNull();
    expect(screen.queryByRole('button', { name: /掲示物を印刷/ })).toBeNull();
    // 失敗時に掲示文言だけが残る形も禁じる（Requirement 4.5「成功したかのような表示をしない」）。
    expect(screen.queryByText(new RegExp(POSTER_INVITATION))).toBeNull();
  });

  // 測っているのは語の不在であって「客の情報の不在」そのものではない。名前を実態へ寄せる
  // （Requirement 5.2 の担保は、掲示面の要素を店名・画像・依頼文・案内の 4 つに限った構造と、
  // その 4 つを固定する上の 2 ケースが担う）。この網は禁止語の混入を拾う側で意味を持つ。
  it('掲示面に評価・件数を指す語が混入しない', async () => {
    await renderReady();
    // 掲示物は店頭に貼られる。客の回答・評価・件数の類が 1 文字でも載ってはならない。
    expect(printRegion().textContent).not.toMatch(/評価|口コミ|レビュー|星|件/);
  });
});

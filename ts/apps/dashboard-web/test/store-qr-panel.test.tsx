// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

import type { ApiResult, BinaryPayload } from '../src/lib/api';

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

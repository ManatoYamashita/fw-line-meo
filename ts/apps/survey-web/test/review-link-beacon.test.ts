import { describe, it, expect, vi, afterEach } from 'vitest';
import { notifyReviewLinkOpened, REVIEW_LINK_OPENED_PATH } from '../src/lib/review-link-beacon';

// 投稿導線の押下の通知（Issue #137・Requirement 5.8）。通知は遷移と独立で、どんな環境でも
// 例外を外へ出さない。ここで投げると、リンクの onClick から例外が漏れて遷移を妨げうる。

const STORE = '44444444-4444-4444-4444-444444444444';
const BODY = JSON.stringify({ storeId: STORE, token: 'T1' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notifyReviewLinkOpened', () => {
  it('sendBeacon があればそれで送る（本文は storeId と token の JSON）', () => {
    const sendBeacon = vi.fn(() => true);
    const fetch = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon });
    vi.stubGlobal('fetch', fetch);

    notifyReviewLinkOpened(STORE, 'T1');

    expect(REVIEW_LINK_OPENED_PATH).toBe('/api/review-link-opened');
    expect(sendBeacon).toHaveBeenCalledWith('/api/review-link-opened', BODY);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sendBeacon が受け付けなかったら keepalive の fetch へ落ちる', () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) });
    vi.stubGlobal('fetch', fetch);

    notifyReviewLinkOpened(STORE, 'T1');

    expect(fetch).toHaveBeenCalledWith('/api/review-link-opened', { method: 'POST', body: BODY, keepalive: true });
  });

  it('sendBeacon が無い環境では keepalive の fetch で送る', () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', fetch);

    notifyReviewLinkOpened(STORE, 'T1');

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fetch が失敗しても例外も未処理の拒否も外へ出さない', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('network down'))));

    expect(() => notifyReviewLinkOpened(STORE, 'T1')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.off('unhandledRejection', onRejection);
    expect(rejections).toEqual([]);
  });

  it('sendBeacon や fetch が同期的に投げても外へ出さない', () => {
    vi.stubGlobal('navigator', {
      sendBeacon: () => {
        throw new TypeError('blocked');
      },
    });
    vi.stubGlobal('fetch', () => {
      throw new TypeError('blocked');
    });

    expect(() => notifyReviewLinkOpened(STORE, 'T1')).not.toThrow();
  });
});

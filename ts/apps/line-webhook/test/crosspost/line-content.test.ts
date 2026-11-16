import { describe, expect, it, vi } from 'vitest';
import { createLineMessenger } from '../../src/line/client.js';

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';

function messengerWith(handle: (url: string) => Response) {
  const fetchMock = vi.fn(async (raw: Parameters<typeof fetch>[0]) => {
    const url = String(raw);
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 900 }), { status: 200 });
    }
    return handle(url);
  });
  const messenger = createLineMessenger({
    channelId: 'c',
    channelSecret: 's',
    fetch: fetchMock as unknown as typeof fetch,
    logger: { warn: vi.fn() },
    requestTimeoutMs: 5000,
  });
  return { messenger, fetchMock };
}

describe('getMessageContent（Content API・line-crosspost）', () => {
  it('本体と Content-Type を返す。api-data.line.me の content を呼ぶ', async () => {
    const { messenger, fetchMock } = messengerWith(
      () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );
    const result = await messenger.getMessageContent('12345', 10);
    expect(result).toEqual({ kind: 'ok', bytes: Buffer.from([1, 2, 3]), contentType: 'image/jpeg' });
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain('https://api-data.line.me/v2/bot/message/12345/content');
  });

  it('上限を超えたら読み止める（Content-Length が無くても）', async () => {
    const { messenger } = messengerWith(() => new Response(new Uint8Array(64), { status: 200 }));
    expect(await messenger.getMessageContent('1', 10)).toEqual({ kind: 'too_large' });
  });

  it('404・410 は gone、202 は not_ready、その他は error。形の誤った ID は呼ばずに gone', async () => {
    expect(await messengerWith(() => new Response(null, { status: 410 })).messenger.getMessageContent('1', 10)).toEqual({ kind: 'gone' });
    expect(await messengerWith(() => new Response(null, { status: 202 })).messenger.getMessageContent('1', 10)).toEqual({
      kind: 'not_ready',
    });
    expect(await messengerWith(() => new Response(null, { status: 500 })).messenger.getMessageContent('1', 10)).toEqual({
      kind: 'error',
      status: 500,
    });
    const { messenger, fetchMock } = messengerWith(() => new Response(null, { status: 200 }));
    expect(await messenger.getMessageContent('../x', 10)).toEqual({ kind: 'gone' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

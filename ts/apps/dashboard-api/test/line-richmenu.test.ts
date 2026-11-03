import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLineRichMenuAdapter, type UnlinkRichMenuResult } from '../src/line-richmenu.js';

// 個別リッチメニューの解除アダプタの単体試験（owner-line-unlink Req 3.1, 3.4）。
// 通信は注入した偽の fetch だけで行い、api.line.me へは出ない（グローバルの fetch を
// 呼ばれたら失敗する形に差し替えて確かめる）。
// API の形は @line/bot-sdk の生成型（issueStatelessChannelToken・unlinkRichMenuIdFromUser）と
// .claude/skills/messaging-api/references（channel-token.md・rich-menu.md）に合わせている。

const CHANNEL_ID = '1234567890';
const CHANNEL_SECRET = 'channel-secret-value';
const LINE_USER_ID = 'U0123456789abcdef0123456789abcdef';
const ACCESS_TOKEN = 'issued-access-token-value';
const ERROR_BODY_MARKER = 'line-error-body-marker';

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const UNLINK_URL = `https://api.line.me/v2/bot/user/${LINE_USER_ID}/richmenu`;

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

type Responder = (call: RecordedCall) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function tokenOk(token = ACCESS_TOKEN): Response {
  return jsonResponse(200, { access_token: token, expires_in: 900, token_type: 'Bearer' });
}

// トークン発行と DELETE のそれぞれへ応答を割り当てる偽の fetch。呼び出しはすべて記録する。
function fakeFetch(handlers: { token: Responder; unlink: Responder }) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call = { url, init };
    calls.push(call);
    if (url === TOKEN_URL) {
      return handlers.token(call);
    }
    return handlers.unlink(call);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function adapterWith(fetchImpl: typeof fetch, timeoutMs = 5_000) {
  return createLineRichMenuAdapter({
    channelId: CHANNEL_ID,
    channelSecret: CHANNEL_SECRET,
    fetch: fetchImpl,
    timeoutMs,
  });
}

// signal が中断されたら AbortError で reject し、それまでは応答しない（時間切れの再現）。
function hangUntilAborted(call: RecordedCall): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = call.init?.signal;
    if (!signal) {
      // 時間制限の signal が渡っていなければ永久に待つ。試験はタイムアウトで赤になる。
      return;
    }
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
}

// 結果に LINE ユーザー ID・トークン・シークレット・応答本文が載らないこと（design.md「Security Considerations」）。
function expectNoSensitiveValues(result: UnlinkRichMenuResult): void {
  const serialized = JSON.stringify(result);
  for (const value of [LINE_USER_ID, ACCESS_TOKEN, CHANNEL_SECRET, ERROR_BODY_MARKER]) {
    expect(serialized).not.toContain(value);
  }
}

describe('createLineRichMenuAdapter: unlinkUserRichMenu', () => {
  const globalFetch = vi.fn(() => {
    throw new Error('グローバルの fetch は呼ばれてはならない');
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', globalFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalFetch.mockClear();
  });

  it('トークンを stateless の client_credentials で発行し、そのトークンで個別リンクを DELETE する', async () => {
    const { fetch, calls } = fakeFetch({
      token: () => Promise.resolve(tokenOk()),
      unlink: () => Promise.resolve(new Response(null, { status: 200 })),
    });

    const result = await adapterWith(fetch).unlinkUserRichMenu(LINE_USER_ID);

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);

    const [tokenCall, unlinkCall] = calls;
    expect(tokenCall?.url).toBe(TOKEN_URL);
    expect(tokenCall?.init?.method).toBe('POST');
    expect(new Headers(tokenCall?.init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(String(tokenCall?.init?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'client_credentials',
      client_id: CHANNEL_ID,
      client_secret: CHANNEL_SECRET,
    });

    expect(unlinkCall?.url).toBe(UNLINK_URL);
    expect(unlinkCall?.init?.method).toBe('DELETE');
    expect(new Headers(unlinkCall?.init?.headers).get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);

    // どちらの通信にも時間制限の signal が付く。
    expect(tokenCall?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(unlinkCall?.init?.signal).toBeInstanceOf(AbortSignal);

    expect(globalFetch).not.toHaveBeenCalled();
  });

  it.each([200, 204])('DELETE の %i を成功として返す', async (status) => {
    const { fetch } = fakeFetch({
      token: () => Promise.resolve(tokenOk()),
      unlink: () => Promise.resolve(new Response(null, { status })),
    });

    await expect(adapterWith(fetch).unlinkUserRichMenu(LINE_USER_ID)).resolves.toEqual({ ok: true });
  });

  it('DELETE の 404 も成功として返す（個別リンクが無いユーザーで外し直しが終わらない事態を避ける）', async () => {
    const { fetch } = fakeFetch({
      token: () => Promise.resolve(tokenOk()),
      unlink: () => Promise.resolve(jsonResponse(404, { message: ERROR_BODY_MARKER })),
    });

    await expect(adapterWith(fetch).unlinkUserRichMenu(LINE_USER_ID)).resolves.toEqual({ ok: true });
  });

  it.each([400, 401, 403, 429, 500, 503])('DELETE の %i を http_error と状態コードで返す', async (status) => {
    const { fetch } = fakeFetch({
      token: () => Promise.resolve(tokenOk()),
      unlink: () => Promise.resolve(jsonResponse(status, { message: ERROR_BODY_MARKER })),
    });

    const result = await adapterWith(fetch).unlinkUserRichMenu(LINE_USER_ID);

    expect(result).toEqual({ ok: false, errorKind: 'http_error', httpStatus: status });
    expectNoSensitiveValues(result);
  });

  it.each([400, 401, 500])('トークン発行の %i を token_failed で返し、DELETE を呼ばない', async (status) => {
    const { fetch, calls } = fakeFetch({
      token: () => Promise.resolve(jsonResponse(status, { error: 'invalid_client', error_description: ERROR_BODY_MARKER })),
      unlink: () => Promise.resolve(new Response(null, { status: 200 })),
    });

    const result = await adapterWith(fetch).unlinkUserRichMenu(LINE_USER_ID);

    expect(result).toEqual({ ok: false, errorKind: 'token_failed', httpStatus: status });
    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL]);
    expectNoSensitiveValues(result);
  });

  it.each([
    ['access_token が無い', () => jsonResponse(200, { expires_in: 900 })],
    ['access_token が空文字', () => jsonResponse(200, { access_token: '', expires_in: 900 })],
    ['本文が JSON でない', () => new Response(`not-json ${ERROR_BODY_MARKER}`, { status: 200 })],
  ])('トークン発行の応答で %s とき token_failed で返し、DELETE を呼ばない', async (_label, respond) => {
    const { fetch, calls } = fakeFetch({
      token: () => Promise.resolve(respond()),
      unlink: () => Promise.resolve(new Response(null, { status: 200 })),
    });

    const result = await adapterWith(fetch).unlinkUserRichMenu(LINE_USER_ID);

    expect(result).toEqual({ ok: false, errorKind: 'token_failed', httpStatus: 200 });
    expect(calls).toHaveLength(1);
    expectNoSensitiveValues(result);
  });

  it('トークン発行の通信が例外を投げたとき token_failed（状態コードなし）で返し、例外を投げない', async () => {
    const { fetch, calls } = fakeFetch({
      token: () => Promise.reject(new TypeError(`fetch failed ${ERROR_BODY_MARKER}`)),
      unlink: () => Promise.resolve(new Response(null, { status: 200 })),
    });

    const result = await adapterWith(fetch).unlinkUserRichMenu(LINE_USER_ID);

    expect(result).toEqual({ ok: false, errorKind: 'token_failed', httpStatus: null });
    expect(calls).toHaveLength(1);
    expectNoSensitiveValues(result);
  });

  it('トークン発行が時間切れになったとき token_failed（状態コードなし）で返す', async () => {
    const { fetch, calls } = fakeFetch({
      token: hangUntilAborted,
      unlink: () => Promise.resolve(new Response(null, { status: 200 })),
    });

    const result = await adapterWith(fetch, 20).unlinkUserRichMenu(LINE_USER_ID);

    expect(result).toEqual({ ok: false, errorKind: 'token_failed', httpStatus: null });
    expect(calls).toHaveLength(1);
  });

  it('DELETE の通信が例外を投げたとき network_error（状態コードなし）で返し、例外を投げない', async () => {
    const { fetch } = fakeFetch({
      token: () => Promise.resolve(tokenOk()),
      unlink: () => Promise.reject(new TypeError(`fetch failed ${LINE_USER_ID} ${ERROR_BODY_MARKER}`)),
    });

    const result = await adapterWith(fetch).unlinkUserRichMenu(LINE_USER_ID);

    expect(result).toEqual({ ok: false, errorKind: 'network_error', httpStatus: null });
    expectNoSensitiveValues(result);
  });

  it('DELETE が時間切れになったとき network_error（状態コードなし）で返す', async () => {
    const { fetch, calls } = fakeFetch({
      token: () => Promise.resolve(tokenOk()),
      unlink: hangUntilAborted,
    });

    const result = await adapterWith(fetch, 20).unlinkUserRichMenu(LINE_USER_ID);

    expect(result).toEqual({ ok: false, errorKind: 'network_error', httpStatus: null });
    expect(calls).toHaveLength(2);
  });

  it('呼び出しごとにトークンを発行し、キャッシュしない', async () => {
    let issued = 0;
    const { fetch, calls } = fakeFetch({
      token: () => {
        issued += 1;
        return Promise.resolve(tokenOk(`token-${issued}`));
      },
      unlink: () => Promise.resolve(new Response(null, { status: 200 })),
    });
    const adapter = adapterWith(fetch);

    await adapter.unlinkUserRichMenu(LINE_USER_ID);
    await adapter.unlinkUserRichMenu(LINE_USER_ID);

    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, UNLINK_URL, TOKEN_URL, UNLINK_URL]);
    const authorizations = calls
      .filter((call) => call.url === UNLINK_URL)
      .map((call) => new Headers(call.init?.headers).get('Authorization'));
    expect(authorizations).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it.each([
    ['all（既定リッチメニューの解除という別の操作のパスになる）', 'all'],
    ['..（URL の正規化で別のパスになる）', '..'],
    ['空文字', ''],
    ['区切り文字を含む値', 'U/a b?c#d'],
    ['16 進でない文字を含む値', 'U0123456789abcdef0123456789abcdeg'],
    ['桁の足りない値', 'U0123456789abcdef'],
  ])('LINE ユーザー ID の形に合わない値（%s）は通信せず invalid_user_id で返す', async (_label, lineUserId) => {
    const { fetch, calls } = fakeFetch({
      token: () => Promise.resolve(tokenOk()),
      unlink: () => Promise.resolve(new Response(null, { status: 200 })),
    });

    const result = await adapterWith(fetch).unlinkUserRichMenu(lineUserId);

    expect(result).toEqual({ ok: false, errorKind: 'invalid_user_id', httpStatus: null });
    // トークンの発行も行わない（資格情報を使う前に止める）
    expect(calls).toEqual([]);
  });

  it('解除以外の LINE の操作を公開しない', () => {
    const { fetch } = fakeFetch({
      token: () => Promise.resolve(tokenOk()),
      unlink: () => Promise.resolve(new Response(null, { status: 200 })),
    });

    expect(Object.keys(adapterWith(fetch))).toEqual(['unlinkUserRichMenu']);
  });
});

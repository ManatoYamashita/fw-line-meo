import { describe, expect, it } from 'vitest';

import { clientKeyFromForwardedFor, createClientKey, parseTrustedProxyIps } from '../src/lib/client-key';

// 流量制限の鍵（Issue #344）。並びは 2026-09-26 に本番で実測した形をそのまま使う。
// 値はすべて文書用アドレス（RFC 5737）。LB がロードバランサ、CLIENT が本物の送信元、FAKE が客の偽装。
const LB = '192.0.2.10';
const CLIENT = '198.51.100.7';
const FAKE = '203.0.113.99';
const TRUSTED = [LB];

describe('clientKeyFromForwardedFor', () => {
  it('run.app 直（末尾が送信元）では末尾を鍵にする', () => {
    expect(clientKeyFromForwardedFor(CLIENT, TRUSTED)).toBe(CLIENT);
  });

  it('ロードバランサ経由（末尾がロードバランサ）では 1 つ手前を鍵にする', () => {
    expect(clientKeyFromForwardedFor(`${CLIENT},${LB}`, TRUSTED)).toBe(CLIENT);
  });

  it('run.app 直で客が先頭に値を足しても鍵は変わらない', () => {
    expect(clientKeyFromForwardedFor(`${FAKE}, ${CLIENT}`, TRUSTED)).toBe(CLIENT);
    expect(clientKeyFromForwardedFor(`${FAKE}, 203.0.113.1, ${CLIENT}`, TRUSTED)).toBe(CLIENT);
  });

  it('ロードバランサ経由で客が先頭に値を足しても鍵は変わらない', () => {
    expect(clientKeyFromForwardedFor(`${FAKE}, ${CLIENT},${LB}`, TRUSTED)).toBe(CLIENT);
  });

  it('run.app 直で客がロードバランサの IP を偽っても、後ろに付く本物の送信元を鍵にする', () => {
    expect(clientKeyFromForwardedFor(`${FAKE}, ${LB}, ${CLIENT}`, TRUSTED)).toBe(CLIENT);
  });

  it('先頭の偽装を毎回変えても、鍵は 1 つに定まる（流量制限をすり抜けられない）', () => {
    const keys = new Set(
      Array.from({ length: 14 }, (_, i) => clientKeyFromForwardedFor(`203.0.113.${i + 1}, ${CLIENT},${LB}`, TRUSTED)),
    );
    expect([...keys]).toEqual([CLIENT]);
  });

  it('ヘッダが無い・空なら unknown', () => {
    expect(clientKeyFromForwardedFor(null, TRUSTED)).toBe('unknown');
    expect(clientKeyFromForwardedFor('', TRUSTED)).toBe('unknown');
    expect(clientKeyFromForwardedFor(' , ', TRUSTED)).toBe('unknown');
  });

  it('ロードバランサの IP だけなら unknown（手前が無い）', () => {
    expect(clientKeyFromForwardedFor(LB, TRUSTED)).toBe('unknown');
  });

  it('信頼する前段が未設定なら常に末尾を鍵にする（run.app 直の経路では正しい）', () => {
    expect(clientKeyFromForwardedFor(`${FAKE}, ${CLIENT}`, [])).toBe(CLIENT);
    // ロードバランサ経由ではロードバランサの IP が鍵になる。env をイメージより先に入れる理由。
    expect(clientKeyFromForwardedFor(`${CLIENT},${LB}`, [])).toBe(LB);
  });
});

describe('parseTrustedProxyIps', () => {
  it('カンマ区切りを分け、空白と空の要素を捨てる', () => {
    expect(parseTrustedProxyIps(undefined)).toEqual([]);
    expect(parseTrustedProxyIps('')).toEqual([]);
    expect(parseTrustedProxyIps(` ${LB} ,, 192.0.2.11 `)).toEqual([LB, '192.0.2.11']);
  });
});

describe('createClientKey', () => {
  it('要求の X-Forwarded-For から鍵を取り出す', () => {
    const key = createClientKey(TRUSTED);
    const req = new Request('https://example.test/api/drafts', {
      method: 'POST',
      headers: { 'x-forwarded-for': `${FAKE}, ${CLIENT},${LB}` },
    });
    expect(key(req)).toBe(CLIENT);
  });
});

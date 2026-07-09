import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DraftMaterial } from './domain';
import { ok, err, type Result } from './result';

// 再生成上限をサーバー無状態で強制するための HMAC 署名トークン。
// - pageToken: ページ経由の正規回答フロー証明（/api/responses 必須・5 分）。
// - sessionToken: 素材＋attempt を封入して往復（サーバーに個別回答を保存しない・30 分）。
// kind をペイロードに封入し、pageToken と sessionToken の相互流用を拒否する。

const PAGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;

export interface PagePayload {
  kind: 'page';
  storeId: string;
  exp: number; // epoch ms
}

export interface SessionPayload {
  kind: 'session';
  v: 1;
  storeId: string;
  material: DraftMaterial;
  attempt: number;
  exp: number; // epoch ms
}

export interface SessionInput {
  storeId: string;
  material: DraftMaterial;
  attempt: number;
}

export type TokenError = 'INVALID' | 'EXPIRED';

export interface SessionTokenService {
  signPage(storeId: string): string;
  verifyPage(token: string, storeId: string): Result<PagePayload, TokenError>;
  sign(input: SessionInput): string;
  verify(token: string): Result<SessionPayload, TokenError>;
}

function sign(body: string, key: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

/**
 * 署名鍵からトークンサービスを生成する。
 * @param signingKey SESSION_SIGNING_KEY（Secret Manager の survey-session-key）
 * @param now テスト用に注入可能な現在時刻（epoch ms・既定 Date.now）
 */
export function createSessionTokenService(
  signingKey: string,
  now: () => number = () => Date.now(),
): SessionTokenService {
  if (!signingKey) throw new Error('signingKey is required');

  function encode(payload: PagePayload | SessionPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${sign(body, signingKey)}`;
  }

  function decode(token: string): Result<unknown, TokenError> {
    const parts = token.split('.');
    if (parts.length !== 2) return err('INVALID');
    const [body, mac] = parts;
    if (!body || !mac) return err('INVALID');
    const expected = sign(body, signingKey);
    const given = Buffer.from(mac);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return err('INVALID');
    try {
      return ok(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    } catch {
      return err('INVALID');
    }
  }

  return {
    signPage(storeId) {
      return encode({ kind: 'page', storeId, exp: now() + PAGE_TTL_MS });
    },

    verifyPage(token, storeId) {
      const decoded = decode(token);
      if (!decoded.ok) return decoded;
      const p = decoded.value as Partial<PagePayload>;
      if (p.kind !== 'page' || typeof p.exp !== 'number' || p.storeId !== storeId) {
        return err('INVALID');
      }
      if (now() > p.exp) return err('EXPIRED');
      return ok({ kind: 'page', storeId, exp: p.exp });
    },

    sign(input) {
      const payload: SessionPayload = {
        kind: 'session',
        v: 1,
        storeId: input.storeId,
        material: input.material,
        attempt: input.attempt,
        exp: now() + SESSION_TTL_MS,
      };
      return encode(payload);
    },

    verify(token) {
      const decoded = decode(token);
      if (!decoded.ok) return decoded;
      const p = decoded.value as Partial<SessionPayload>;
      if (
        p.kind !== 'session' ||
        p.v !== 1 ||
        typeof p.exp !== 'number' ||
        typeof p.storeId !== 'string' ||
        typeof p.attempt !== 'number' ||
        p.material == null
      ) {
        return err('INVALID');
      }
      if (now() > p.exp) return err('EXPIRED');
      return ok(p as SessionPayload);
    },
  };
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DraftMaterial } from './domain';
import { ok, err, type Result } from './result';

// 再生成上限をサーバー無状態で強制するための HMAC 署名トークン。
// - pageToken: ページ経由の正規回答フロー証明（/api/responses 必須・5 分）。
// - sessionToken: 素材＋attempt を封入して往復（サーバーに個別回答を保存しない・30 分）。
// kind をペイロードに封入し、pageToken と sessionToken の相互流用を拒否する。
// pageToken は版つきの union（Issue #436）: 版の印を持たない legacy と、表示時の店舗設定の版
// （surveyRevision）を署名する structured（v = 2）。legacy の token の形と検証は変えていない。

const PAGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;

/** legacy survey の pageToken（版の印を持たない。structured survey 以前からの形）。 */
export interface LegacyPagePayload {
  kind: 'page';
  storeId: string;
  exp: number; // epoch ms
}

/**
 * structured survey の pageToken（Issue #436）。表示時の店舗設定の版（store_survey_configs.revision）を
 * 署名する。送信時に現在の版と一致しなければ、古い画面の回答を新しい設定として解釈しない。
 */
export interface StructuredPagePayload {
  kind: 'page';
  v: 2;
  storeId: string;
  surveyRevision: number;
  exp: number; // epoch ms
}

export type PagePayload = LegacyPagePayload | StructuredPagePayload;

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
  /** structured survey の pageToken（Issue #438 で画面へ接続する。この PR の時点では呼び手が無い）。 */
  signStructuredPage(storeId: string, surveyRevision: number): string;
  /**
   * pageToken の **署名・種別・店舗・期限だけ** を検証する。legacy と structured（v = 2）の両方を通す。
   *
   * **通った = 回答を受理してよい、ではない（Issue #436）。** structured の token は、表示の後に店舗が
   * 設定を変えていれば古い画面である。回答受付（Issue #438）は必ず次の順にすること:
   *   1. verifyPage（署名・期限）
   *   2. checkSurveyRevision（現在の店舗の survey の種類・版との照合。戻り値で legacy / structured の
   *      どちらの検証を使うかが決まる）
   *   3. 回答の検証（legacy は validateSurveyAnswer、structured は validateStructuredAnswer）
   * 現在の legacy の回答受付は 1 だけを行う。structured の token を発行する経路がまだ無い
   * （signStructuredPage の呼び手が無い）ので挙動は変わらないが、Issue #438 で発行を始めるときは
   * 同時に 2 を接続すること。
   */
  verifyPage(token: string, storeId: string): Result<PagePayload, TokenError>;
  sign(input: SessionInput): string;
  verify(token: string): Result<SessionPayload, TokenError>;
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** 回答を受け付けるときに使う survey の種類と版（@fwlm/db の StoreSurveyDefinition が満たす形）。 */
export type CurrentSurvey = { mode: 'legacy' } | { mode: 'structured'; revision: number };

export type SurveyRevisionError = 'STALE_SURVEY';

/**
 * pageToken が署名した画面の種類・版が、現在の店舗の survey と一致するかを判定する（Issue #436）。
 *
 * - legacy の token × legacy の店舗 → 'legacy'
 * - structured の token × structured の店舗 × 同じ版 → 'structured'
 * - 版が違う・種類が違う（表示の後に店舗が structured を有効 / 無効にした）→ STALE_SURVEY
 *   古い画面の選択を現在の設定として解釈しない。呼び手は再読み込みを案内する。
 *
 * 署名と期限の検証は verifyPage が済ませている前提。ここは純粋な照合だけを行う。回答の検証より
 * **前に** 呼ぶ（古い画面の選択を現在の定義で検証すると、客が見た名称から変更された Target の選択を、
 * 現在の名称の選択として受理しうる）。
 * 順序の全体は SessionTokenService.verifyPage の説明を参照。
 */
export function checkSurveyRevision(
  page: PagePayload,
  current: CurrentSurvey,
): Result<'legacy' | 'structured', SurveyRevisionError> {
  if (!('v' in page)) return current.mode === 'legacy' ? ok('legacy') : err('STALE_SURVEY');
  if (current.mode !== 'structured' || current.revision !== page.surveyRevision) {
    return err('STALE_SURVEY');
  }
  return ok('structured');
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

    signStructuredPage(storeId, surveyRevision) {
      if (!isRevision(surveyRevision)) throw new Error('surveyRevision must be a positive integer');
      return encode({ kind: 'page', v: 2, storeId, surveyRevision, exp: now() + PAGE_TTL_MS });
    },

    // 版の印（v）を持たない token は legacy として従来どおりに検証し、従来と同じ形で返す。
    // v = 2 は structured で、surveyRevision が正の整数であることまで確かめる。それ以外の v は拒否する。
    verifyPage(token, storeId) {
      const decoded = decode(token);
      if (!decoded.ok) return decoded;
      const p = decoded.value as Partial<StructuredPagePayload> & { v?: unknown };
      if (p.kind !== 'page' || typeof p.exp !== 'number' || p.storeId !== storeId) {
        return err('INVALID');
      }
      if (p.v === undefined) {
        if (now() > p.exp) return err('EXPIRED');
        return ok({ kind: 'page', storeId, exp: p.exp });
      }
      if (p.v !== 2 || !isRevision(p.surveyRevision)) return err('INVALID');
      if (now() > p.exp) return err('EXPIRED');
      return ok({ kind: 'page', v: 2, storeId, surveyRevision: p.surveyRevision, exp: p.exp });
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

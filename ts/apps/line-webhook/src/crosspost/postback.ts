// 一括発信の postback data（design.md「postback」）。形式は onboarding・GBP と同じ `a=<action>&...`。
// action はすべて `x_` で始まり、GBP（`g_`）・レポート（`rpt`）・オンボーディングと衝突しない。
//
// 責任分界: ここが行うのは **形式の検証だけ**。下書き ID・投稿先 ID は UUID の形であること、版は非負の整数で
// あることしか保証しない。端末から偽造できるので、そのオーナーの行かどうかは flows と SQL（@fwlm/db の
// crosspost.ts は全文に owner_id を含める）が必ず確かめる（Req 8.1）。

import type { CrosspostDestination } from './domain.js';

/** 投稿先の選び方（最終確認と承認で使う）。 */
export type DestinationChoice = 'instagram' | 'google' | 'both';

export type CrosspostPostback =
  | { action: 'x_start'; storeId: string | null }
  | { action: 'x_resume' }
  | { action: 'x_new'; storeId: string | null }
  | { action: 'x_gen'; draftId: string }
  | { action: 'x_regen'; draftId: string; revision: number; destination: CrosspostDestination }
  | { action: 'x_ai'; draftId: string; revision: number; destination: CrosspostDestination }
  | { action: 'x_edit'; draftId: string; revision: number; destination: CrosspostDestination }
  | { action: 'x_view'; draftId: string }
  | { action: 'x_conf'; draftId: string; revision: number; choice: DestinationChoice }
  | { action: 'x_ok'; draftId: string; revision: number; choice: DestinationChoice }
  | { action: 'x_cancel'; draftId: string }
  | { action: 'x_status' }
  | { action: 'x_retry'; deliveryId: string }
  /** 待ち（一度も送っていない）の投稿先を今すぐ送る（処理が止まった後の再開・Req 6.11）。 */
  | { action: 'x_run'; deliveryId: string }
  /** 待ちの投稿先を取りやめる。 */
  | { action: 'x_drop'; deliveryId: string }
  | { action: 'x_check'; deliveryId: string }
  | { action: 'x_seen'; deliveryId: string; posted: boolean };

const MAX_POSTBACK_DATA_LENGTH = 300;
const PREFIX = 'x_';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NON_NEGATIVE_INTEGER_PATTERN = /^\d{1,9}$/;

const DESTINATION_CODES: Readonly<Record<CrosspostDestination, string>> = { instagram: 'ig', google: 'gg' };
const CHOICE_CODES: Readonly<Record<DestinationChoice, string>> = { instagram: 'ig', google: 'gg', both: 'both' };

/** 選び方を投稿先の並びに直す（表示順）。 */
export function choiceToDestinations(choice: DestinationChoice): CrosspostDestination[] {
  return choice === 'both' ? ['instagram', 'google'] : [choice];
}

export function encodeCrosspostPostback(postback: CrosspostPostback): string {
  const params = new URLSearchParams({ a: postback.action });
  switch (postback.action) {
    case 'x_start':
      if (postback.storeId !== null) params.set('s', postback.storeId);
      break;
    case 'x_new':
      if (postback.storeId !== null) params.set('s', postback.storeId);
      break;
    case 'x_gen':
    case 'x_view':
    case 'x_cancel':
      params.set('d', postback.draftId);
      break;
    case 'x_regen':
    case 'x_ai':
    case 'x_edit':
      params.set('d', postback.draftId);
      params.set('r', String(postback.revision));
      params.set('k', DESTINATION_CODES[postback.destination]);
      break;
    case 'x_conf':
    case 'x_ok':
      params.set('d', postback.draftId);
      params.set('r', String(postback.revision));
      params.set('t', CHOICE_CODES[postback.choice]);
      break;
    case 'x_retry':
    case 'x_run':
    case 'x_drop':
    case 'x_check':
      params.set('v', postback.deliveryId);
      break;
    case 'x_seen':
      params.set('v', postback.deliveryId);
      params.set('y', postback.posted ? '1' : '0');
      break;
    case 'x_resume':
    case 'x_status':
      break;
  }
  const encoded = params.toString();
  if (encoded.length > MAX_POSTBACK_DATA_LENGTH) {
    throw new Error(`encodeCrosspostPostback: encoded data exceeds ${MAX_POSTBACK_DATA_LENGTH} chars`);
  }
  return encoded;
}

/** 一括発信の postback か（action の妥当性までは見ない。未知の `x_*` も true）。 */
export function isCrosspostPostbackData(data: string): boolean {
  const params = parse(data);
  return params !== null && (params.get('a') ?? '').startsWith(PREFIX);
}

/** 形式が正しければ復号する。誤り（未知の action・欠けた項目・形の誤り）は null。例外は投げない。 */
export function decodeCrosspostPostback(data: string): CrosspostPostback | null {
  const params = parse(data);
  if (params === null) return null;
  const draftId = uuid(params.get('d'));
  const deliveryId = uuid(params.get('v'));
  const revision = nonNegativeInteger(params.get('r'));
  const destination = decodeDestination(params.get('k'));
  const choice = decodeChoice(params.get('t'));

  switch (params.get('a')) {
    case 'x_start': {
      const raw = params.get('s');
      if (raw === null) return { action: 'x_start', storeId: null };
      const storeId = uuid(raw);
      return storeId === null ? null : { action: 'x_start', storeId };
    }
    case 'x_resume':
      return { action: 'x_resume' };
    case 'x_new': {
      const raw = params.get('s');
      if (raw === null) return { action: 'x_new', storeId: null };
      const storeId = uuid(raw);
      return storeId === null ? null : { action: 'x_new', storeId };
    }
    case 'x_gen':
      return draftId === null ? null : { action: 'x_gen', draftId };
    case 'x_view':
      return draftId === null ? null : { action: 'x_view', draftId };
    case 'x_cancel':
      return draftId === null ? null : { action: 'x_cancel', draftId };
    case 'x_regen':
    case 'x_ai':
    case 'x_edit': {
      if (draftId === null || revision === null || destination === null) return null;
      return { action: params.get('a') as 'x_regen' | 'x_ai' | 'x_edit', draftId, revision, destination };
    }
    case 'x_conf':
    case 'x_ok': {
      if (draftId === null || revision === null || choice === null) return null;
      return { action: params.get('a') as 'x_conf' | 'x_ok', draftId, revision, choice };
    }
    case 'x_status':
      return { action: 'x_status' };
    case 'x_retry':
      return deliveryId === null ? null : { action: 'x_retry', deliveryId };
    case 'x_run':
      return deliveryId === null ? null : { action: 'x_run', deliveryId };
    case 'x_drop':
      return deliveryId === null ? null : { action: 'x_drop', deliveryId };
    case 'x_check':
      return deliveryId === null ? null : { action: 'x_check', deliveryId };
    case 'x_seen': {
      const y = params.get('y');
      if (deliveryId === null || (y !== '1' && y !== '0')) return null;
      return { action: 'x_seen', deliveryId, posted: y === '1' };
    }
    default:
      return null;
  }
}

function parse(data: string): URLSearchParams | null {
  if (typeof data !== 'string' || data.length === 0 || data.length > MAX_POSTBACK_DATA_LENGTH) return null;
  try {
    return new URLSearchParams(data);
  } catch {
    return null;
  }
}

function uuid(raw: string | null): string | null {
  return raw !== null && UUID_PATTERN.test(raw) ? raw.toLowerCase() : null;
}

function nonNegativeInteger(raw: string | null): number | null {
  if (raw === null || !NON_NEGATIVE_INTEGER_PATTERN.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function decodeDestination(raw: string | null): CrosspostDestination | null {
  if (raw === 'ig') return 'instagram';
  if (raw === 'gg') return 'google';
  return null;
}

function decodeChoice(raw: string | null): DestinationChoice | null {
  if (raw === 'ig') return 'instagram';
  if (raw === 'gg') return 'google';
  if (raw === 'both') return 'both';
  return null;
}

// GBP 系 postback data の型・符号化/復号（design.md「GbpPostback」・spec task 2.3）。
// Requirements: 1.3（複数店舗オーナーの連携対象店舗選択）, 3.3（投稿下書きの
// 承認/再生成/修正の選択肢）, 4.3（返信下書きの承認/再生成/修正の選択肢）。
//
// 符号化スキームは onboarding（`src/onboarding/stages.ts`）で確立済みの
// URLSearchParams 形式 `a=<action>&...`・300 字上限・不正時 null フォールバックを
// そのまま踏襲する。ただし action 名前空間は独立で、GBP 系はすべて `g_` プレフィックスを
// 持つ（design.md のディスパッチ規則: `a` が `g_` で始まる postback は GbpFlows へ、
// それ以外は既存 onboarding へ）。両者の decode は相互に相手の action を受理しない。
//
// 責任分界（重要）:
// - 本モジュールが行うのは **形式検証のみ**。`g_disconnect` の storeId は UUID 形式で
//   あることしか保証しない（postback data は端末から送られてくるため偽造可能）。
//   対象店舗が本当にそのオーナーの所有かどうかの **所有検証は GbpFlows の責務** であり、
//   必ず ownerId 付きのアクセサ経由で検証すること（design.md Security Considerations:
//   「postback data の storeId は信用せず、必ず所有検証を通す」・Requirement 2.6）。
// - index も同様に「非負の安全な整数」までしか検証しない。セッション保存済みの
//   候補配列・クチコミ配列との照合（古いカルーセルからの操作の無効化）は GbpFlows 側。

export type GbpPostbackAction =
  | { action: 'g_connect' }
  | { action: 'g_pick_store'; index: number }
  | { action: 'g_status' }
  | { action: 'g_disconnect'; storeId: string }
  /**
   * 失効した連携の張り直し（PR #121 レビュー指摘）。`g_connect` は `isLinked`（oauth_tokens
   * 行の存在のみ）で短絡するため、失効中は「すでに連携済み」しか返せず行き止まりになる。
   * 本 action は古い認可情報を消してから認可 URL を発行する経路を指す。
   * storeId の所有検証は GbpFlows の責務（`g_disconnect` と同じ）。
   */
  | { action: 'g_relink'; storeId: string }
  | { action: 'g_post' }
  | { action: 'g_reply' }
  | { action: 'g_pick_review'; index: number }
  | { action: 'g_approve' }
  | { action: 'g_regen' }
  | { action: 'g_revise' }
  | { action: 'g_overwrite' }
  | { action: 'g_cancel' };

// LINE Messaging API の postback data 上限（references/action-objects.md 準拠。
// onboarding 側と同一の値だが、モジュール間の暗黙結合を作らないため各所で定義する）。
const MAX_POSTBACK_DATA_LENGTH = 300;

/** GBP 系 action を識別するプレフィックス（onboarding との名前空間分離の唯一の根拠）。 */
const GBP_ACTION_PREFIX = 'g_';

/** 非負整数のみを許容する十進数文字列判定（符号・小数・指数・空文字は不可）。 */
const NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/;

/** storeId の形式検証（packages/db の UUID_RE と同一形式）。所有検証は含まない。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeGbpPostback(action: GbpPostbackAction): string {
  const encoded = ((): string => {
    switch (action.action) {
      case 'g_pick_store':
        return `a=g_pick_store&i=${action.index}`;
      case 'g_pick_review':
        return `a=g_pick_review&i=${action.index}`;
      case 'g_disconnect':
        return `a=g_disconnect&s=${encodeURIComponent(action.storeId)}`;
      case 'g_relink':
        return `a=g_relink&s=${encodeURIComponent(action.storeId)}`;
      case 'g_connect':
      case 'g_status':
      case 'g_post':
      case 'g_reply':
      case 'g_approve':
      case 'g_regen':
      case 'g_revise':
      case 'g_overwrite':
      case 'g_cancel':
        return `a=${action.action}`;
    }
  })();

  // 候補・クチコミは高々十数件、storeId は UUID 固定長のため実運用では常に十分短いが、
  // 300 字保証は呼び出し側が信頼できる不変条件として明示的に検証しておく。
  if (encoded.length > MAX_POSTBACK_DATA_LENGTH) {
    throw new Error(`encodeGbpPostback: encoded data exceeds ${MAX_POSTBACK_DATA_LENGTH} chars`);
  }

  return encoded;
}

/**
 * postback data が GBP 系かどうかの最小判定（conversation.ts のディスパッチ分岐用）。
 * action 名の妥当性までは見ない（未知の `g_*` も true）。未知 action の案内フォールバックは
 * GbpFlows 側が担い、onboarding へ誤って流さないことをここで保証する。
 */
export function isGbpPostbackData(data: string): boolean {
  const params = parsePostbackData(data);
  return params !== null && (params.get('a') ?? '').startsWith(GBP_ACTION_PREFIX);
}

export function decodeGbpPostback(data: string): GbpPostbackAction | null {
  const params = parsePostbackData(data);
  if (params === null) {
    return null;
  }

  switch (params.get('a')) {
    case 'g_connect':
      return { action: 'g_connect' };
    case 'g_pick_store': {
      const index = parseIndex(params.get('i'));
      return index === null ? null : { action: 'g_pick_store', index };
    }
    case 'g_status':
      return { action: 'g_status' };
    case 'g_disconnect': {
      // 形式検証のみ。所有検証（このオーナーの店舗か）は GbpFlows が必ず行う。
      const storeId = params.get('s');
      if (storeId === null || !UUID_PATTERN.test(storeId)) {
        return null;
      }
      return { action: 'g_disconnect', storeId };
    }
    case 'g_relink': {
      // g_disconnect と同じ規律（形式検証のみ・所有検証は GbpFlows）。
      const storeId = params.get('s');
      if (storeId === null || !UUID_PATTERN.test(storeId)) {
        return null;
      }
      return { action: 'g_relink', storeId };
    }
    case 'g_post':
      return { action: 'g_post' };
    case 'g_reply':
      return { action: 'g_reply' };
    case 'g_pick_review': {
      const index = parseIndex(params.get('i'));
      return index === null ? null : { action: 'g_pick_review', index };
    }
    case 'g_approve':
      return { action: 'g_approve' };
    case 'g_regen':
      return { action: 'g_regen' };
    case 'g_revise':
      return { action: 'g_revise' };
    case 'g_overwrite':
      return { action: 'g_overwrite' };
    case 'g_cancel':
      return { action: 'g_cancel' };
    default:
      return null;
  }
}

/** 共通の入口検証（型・長さ・パース）。不正なら null を返し、例外は投げない。 */
function parsePostbackData(data: string): URLSearchParams | null {
  if (typeof data !== 'string' || data.length === 0 || data.length > MAX_POSTBACK_DATA_LENGTH) {
    return null;
  }
  try {
    return new URLSearchParams(data);
  } catch {
    return null;
  }
}

/** 候補インデックスの検証。負数・非整数・指数表記・安全整数超過はすべて拒否する。 */
function parseIndex(raw: string | null): number | null {
  if (raw === null || !NON_NEGATIVE_INTEGER_PATTERN.test(raw)) {
    return null;
  }
  const index = Number(raw);
  return Number.isSafeInteger(index) ? index : null;
}

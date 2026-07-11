// オンボーディング会話状態機械の型・postback data 符号化/復号（design.md「OnboardingStages」）。
// Requirement 1.3: await_invite_code 中は店舗特定系 postback（select_candidate/confirm）を
// stage ガードで拒否する（本モジュールは型と符号化のみを提供し、ガード判定自体は
// ConversationHandlers 側・タスク 3.x が担う）。
// Requirement 4.5: 確定取りやめ（restart）で await_store_name へ戻す遷移の postback を表現する。
// Requirement 4.6: completed 到達後は追加入力を要求しない（stateDiagram-v2: completed --> completed）。
//
// postback data の符号化スキームは research.md「Decision 5: 候補選択 = インデックス方式
// postback＋セッション照合」で決定済みの `a=select&i=<index>` 形式を全 action に拡張する
// （a=<action> の短いキー=値形式。LINE の postback data 上限 300 文字に対し十分に短い）。
// セッション保存済みの候補配列との照合（古いカルーセルからの操作・偽造 data の無効化）は
// 本モジュールの責務外（ConversationHandlers・StoreIdentificationService 側で index を照合する）。

export type OnboardingStage =
  | 'await_invite_code'
  | 'await_store_name'
  | 'await_confirmation'
  | 'completed';

export type PostbackAction =
  | { kind: 'select_candidate'; index: number }
  | { kind: 'confirm' }
  | { kind: 'restart' }
  | { kind: 'resume' }; // リッチメニュー再開導線（Requirement 6.2）

// LINE Messaging API の postback data 上限（references/action-objects.md 準拠）。
const MAX_POSTBACK_DATA_LENGTH = 300;

export function encodePostback(action: PostbackAction): string {
  const encoded = ((): string => {
    switch (action.kind) {
      case 'select_candidate':
        return `a=select&i=${action.index}`;
      case 'confirm':
        return 'a=confirm';
      case 'restart':
        return 'a=restart';
      case 'resume':
        return 'a=resume';
    }
  })();

  // 候補は最大 10 件（Requirement 3.1）のため index は常に短い十進数に収まるが、
  // 300 字保証は呼び出し側が信頼できる不変条件として明示的に検証しておく。
  if (encoded.length > MAX_POSTBACK_DATA_LENGTH) {
    throw new Error(`encodePostback: encoded data exceeds ${MAX_POSTBACK_DATA_LENGTH} chars`);
  }

  return encoded;
}

// 非負整数のみを許容する十進数文字列判定（先頭ゼロ許容・符号/小数/空文字は不可）。
const NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/;

export function decodePostback(data: string): PostbackAction | null {
  if (typeof data !== 'string' || data.length === 0 || data.length > MAX_POSTBACK_DATA_LENGTH) {
    return null;
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(data);
  } catch {
    return null;
  }

  switch (params.get('a')) {
    case 'select': {
      const rawIndex = params.get('i');
      if (rawIndex === null || !NON_NEGATIVE_INTEGER_PATTERN.test(rawIndex)) {
        return null;
      }
      const index = Number(rawIndex);
      if (!Number.isSafeInteger(index)) {
        return null;
      }
      return { kind: 'select_candidate', index };
    }
    case 'confirm':
      return { kind: 'confirm' };
    case 'restart':
      return { kind: 'restart' };
    case 'resume':
      return { kind: 'resume' };
    default:
      return null;
  }
}

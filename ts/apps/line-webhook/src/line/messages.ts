import type { StoreCandidate } from '@fwlm/db';
import { encodePostback } from '../onboarding/stages.js';
import type { LineMessage } from './client.js';

// メッセージビルダー（design.md「MessageBuilders」）。
// Requirement 1.1: 友だち追加時の挨拶＋招待コード入力案内。
// Requirement 2.2: 無効な招待コード時の再入力案内（本モジュールは文言のみを提供する。
//   有効/無効の判定自体は ConversationHandlers・タスク 3.x の責務）。
// Requirement 3.1: 店舗候補一覧（最大 10 件・店名＋住所）を選択可能な Flex カルーセルで提示する。
// Requirement 4.1: 選択済み候補の確認＋確定/やり直しの意思確認を提示する。
// Requirement 4.3: 店舗特定完了案内（機能1 が利用可能になる旨）。
// Requirement 7.4: すべての案内文を日本語で提供する（文言をこのモジュールに集約する）。
//
// 純粋関数のみ（design.md「MessageBuilders」制約）。I/O・副作用・LineMessenger/DB への
// 依存は一切持たない。postback data の符号化は onboarding/stages.ts の encodePostback を
// そのまま再利用し、ここで独自に符号化スキームを再実装しない。

// --- Flex コンテンツの内部型（references/flex-message.md 準拠・no-explicit-any 対応） ---
// LineMessage['contents'] は unknown のため、ビルダー内部では以下の狭い型で構築し、
// 呼び出し側（テスト等）が安全にキャストできるよう export しておく。

export interface FlexPostbackAction {
  readonly type: 'postback';
  readonly label: string;
  readonly data: string;
  readonly displayText: string;
}

export interface FlexTextComponent {
  readonly type: 'text';
  readonly text: string;
  readonly weight?: 'regular' | 'bold';
  readonly size?: string;
  readonly color?: string;
  readonly wrap?: boolean;
}

export interface FlexButtonComponent {
  readonly type: 'button';
  readonly style: 'primary' | 'secondary';
  readonly action: FlexPostbackAction;
}

export type FlexBoxContent = FlexTextComponent | FlexButtonComponent;

export interface FlexBoxComponent {
  readonly type: 'box';
  readonly layout: 'horizontal' | 'vertical';
  readonly spacing?: string;
  readonly contents: readonly FlexBoxContent[];
}

export interface FlexBubbleContents {
  readonly type: 'bubble';
  readonly size?: string;
  readonly body: FlexBoxComponent;
  readonly footer: FlexBoxComponent;
}

export interface FlexCarouselContents {
  readonly type: 'carousel';
  readonly contents: readonly FlexBubbleContents[];
}

// PlacesSearchAdapter の契約（design.md: pageSize:10）と一致させる不変条件。
// LINE の Carousel 上限は 12 だが、本サービスの契約はさらに厳しい 10 件のため、
// それを超える呼び出しは（LINE の上限内であっても）契約違反として早期に落とす。
const MAX_CANDIDATES = 10;

function assertCandidatesWithinContract(candidates: readonly StoreCandidate[]): void {
  if (candidates.length === 0) {
    throw new Error('buildCandidateCarouselMessage: candidates must not be empty');
  }
  if (candidates.length > MAX_CANDIDATES) {
    throw new Error(
      `buildCandidateCarouselMessage: candidates exceeds contract limit of ${MAX_CANDIDATES} (got ${candidates.length})`,
    );
  }
}

function buildCandidateBubble(candidate: StoreCandidate, index: number): FlexBubbleContents {
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: candidate.name, weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: candidate.address, size: 'sm', color: '#888888', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'primary',
          action: {
            type: 'postback',
            label: 'この店舗を選ぶ',
            data: encodePostback({ kind: 'select_candidate', index }),
            displayText: `${index + 1}番目の候補を選択`,
          },
        },
      ],
    },
  };
}

/** Requirement 1.1: 友だち追加時の挨拶＋招待コード入力案内。 */
export function buildGreetingMessage(): LineMessage {
  return {
    type: 'text',
    text:
      '友だち追加ありがとうございます。\n' +
      '本サービスのご利用には、代理店から発行された招待コードが必要です。\n' +
      '招待コードをこのトークにそのまま送信してください。',
  };
}

/** Requirement 2.2: 無効な招待コード送信時の再入力案内。 */
export function buildInvalidInviteCodeMessage(): LineMessage {
  return {
    type: 'text',
    text:
      '入力されたコードが正しくないか、無効化されています。\n' +
      '招待コードをご確認のうえ、もう一度送信してください。',
  };
}

/**
 * Requirement 2.3: 連続 5 回の無効コード送信によるロック中（またはロック発生時）の案内。
 * ロック中の以後の入力にもこの案内のみを返し、コード再検証や失敗カウント加算は行わない
 * （判定自体は ConversationHandlers・タスク 3.2 の責務）。
 */
export function buildInviteCodeLockedMessage(): LineMessage {
  return {
    type: 'text',
    text:
      '招待コードの入力に複数回失敗したため、しばらくの間コードの入力を停止しています。\n' +
      '10分ほど時間をおいてから、もう一度お試しください。',
  };
}

/** Requirement 2.1: 有効な招待コード確認後、店名の入力を案内する。 */
export function buildStoreNameInputGuidanceMessage(): LineMessage {
  return {
    type: 'text',
    text:
      '招待コードを確認しました。\n' +
      '続いて、お店の名前をこのトークに送信してください。候補からお店を選んでいただきます。',
  };
}

/**
 * Requirement 4.6: 「店舗特定済み」到達後の入力に対する固定案内。
 * Requirement 4.3 の完了直後メッセージ（buildCompletionMessage）とは異なる場面
 * （「たった今完了した」ではなく「すでに完了済みであり追加操作は不要」）のための、
 * 意図的に別立てのメッセージ。
 */
export function buildAlreadyCompletedMessage(): LineMessage {
  return {
    type: 'text',
    text:
      'オンボーディングはすでに完了しています。\n' +
      '機能1（競合店舗の日次サマリー）をご利用いただけます。追加の操作は必要ありません。',
  };
}

/**
 * Requirement 3.1: 店舗候補一覧（最大 10 件・店名＋住所）を選択可能な Flex カルーセルで提示する。
 * 入力は 1〜10 件を前提とする契約（PlacesSearchAdapter が pageSize:10 で保証）。
 * 0 件・11 件以上は呼び出し側の契約違反として例外を投げる（design.md「候補一覧（最大10件）」）。
 */
export function buildCandidateCarouselMessage(candidates: readonly StoreCandidate[]): LineMessage {
  assertCandidatesWithinContract(candidates);

  const contents: FlexCarouselContents = {
    type: 'carousel',
    contents: candidates.map((candidate, index) => buildCandidateBubble(candidate, index)),
  };

  return {
    type: 'flex',
    altText: `店舗候補が${candidates.length}件見つかりました。トークから該当する店舗を選択してください。`,
    contents,
  };
}

/** Requirement 4.1: 選択済み候補の確認＋確定/やり直しの意思確認。 */
export function buildConfirmationMessage(candidate: StoreCandidate): LineMessage {
  const contents: FlexBubbleContents = {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: 'この店舗でよろしいですか？', weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: candidate.name, size: 'md', wrap: true },
        { type: 'text', text: candidate.address, size: 'sm', color: '#888888', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          action: {
            type: 'postback',
            label: '確定する',
            data: encodePostback({ kind: 'confirm' }),
            displayText: '確定する',
          },
        },
        {
          type: 'button',
          style: 'secondary',
          action: {
            type: 'postback',
            label: 'やり直す',
            data: encodePostback({ kind: 'restart' }),
            displayText: 'やり直す',
          },
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: `「${candidate.name}」でよろしいですか？内容をご確認のうえ確定してください。`,
    contents,
  };
}

/** Requirement 4.3: 店舗特定完了案内（機能1＝競合日次サマリーが利用可能になる旨）。 */
export function buildCompletionMessage(): LineMessage {
  return {
    type: 'text',
    text:
      '店舗の登録が完了しました。\n' +
      'これで機能1（競合店舗の日次サマリー）がご利用いただけます。トークやメニューからご確認ください。',
  };
}

/** Requirement 3.2: 店舗候補が 0 件だったときの、表記を変えた再入力案内。 */
export function buildStoreNotFoundMessage(): LineMessage {
  return {
    type: 'text',
    text:
      '該当する店舗が見つかりませんでした。\n' +
      '正式名称やカタカナ表記など、表記を変えてもう一度お店の名前を送信してください。',
  };
}

/** Requirement 3.3: 店舗候補の検索が外部要因で失敗したときのエラー案内。進捗は保持される。 */
export function buildSearchFailedMessage(): LineMessage {
  return {
    type: 'text',
    text:
      '店舗の検索中にエラーが発生しました。\n' +
      '時間をおいて、もう一度お店の名前を送信してください。',
  };
}

/**
 * Requirement 4.4: 選択された店舗がすでに他のオーナーの店舗として登録済みのため、
 * 確定を行わなかった旨と運営への問い合わせ方法の案内。
 */
export function buildPlaceAlreadyRegisteredMessage(): LineMessage {
  return {
    type: 'text',
    text:
      'この店舗はすでに別のオーナー様の店舗として登録されているため、確定できませんでした。\n' +
      '心当たりがない場合は、お手数ですが運営までお問い合わせください。',
  };
}

/**
 * 古いカルーセルからの選択・セッションに候補が保存されていない状態での選択など、
 * セッション上の候補と一致しない select_candidate postback を受け取った際の安全側フォールバック案内
 * （Requirement 3.4 隣接: クラッシュや誤選択を避け、店名からの再検索を促す）。
 */
export function buildCandidateSelectionExpiredMessage(): LineMessage {
  return {
    type: 'text',
    text:
      'この候補は選択できませんでした（表示から時間が経っている可能性があります）。\n' +
      'お手数ですが、もう一度お店の名前を送信して検索し直してください。',
  };
}

/**
 * Requirement 7.5: オーナーの操作を処理できなかった内部障害発生時の、汎用の再試行案内
 * （運営への問い合わせ方法を含む）。app.ts のエラー境界（タスク 4.1）が、dispatch() 内で
 * 捕捉されなかった内部例外の発生時にベストエフォートで送信を試みる文言。
 * どの段階（招待コード／店名検索／確認）で発生した障害かに関わらず共通の汎用文言とする
 * （design.md ConversationHandlers「汎用の再試行案内 reply」）。
 */
export function buildInternalErrorRetryMessage(): LineMessage {
  return {
    type: 'text',
    text:
      '申し訳ございません、処理中にエラーが発生しました。\n' +
      'お手数ですが、少し時間をおいてもう一度お試しください。\n' +
      '解決しない場合は、運営までお問い合わせください。',
  };
}

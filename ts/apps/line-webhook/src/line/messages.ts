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
 * Requirement 1.2: 登録済みオーナーの再友だち追加時、進捗に応じた次の手順を案内する。
 * 段階別の精密な再開文言はタスク 3.3/3.4 が担うため、本メッセージは
 * 「登録済み・続きから再開できる」ことのみを伝える汎用の最小案内とする。
 */
export function buildResumeGuidanceMessage(): LineMessage {
  return {
    type: 'text',
    text:
      'すでにご登録いただいています。\n' +
      '前回の続きから手続きを再開できますので、案内に従って操作してください。',
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

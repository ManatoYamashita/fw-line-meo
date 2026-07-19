// GBP 連携系フローの LINE メッセージ組立（design.md「GbpMessages」・spec task 3.3）。
// Requirements: 1.1（Place 確定済み店舗のみ誘導）, 1.2（認可手続きへの誘導）,
//   1.3（複数店舗の選択）, 2.4（連携解除後の未連携案内）, 2.5（連携状態の提示）。
//
// 制約（onboarding の line/messages.ts と同一の規律）:
// - 純粋関数のみ。I/O・副作用・DB / LineMessenger への依存を持たない。
// - postback data の符号化は `./postback.ts` の encodeGbpPostback のみを使い、ここで
//   独自スキームを再実装しない。
// - Flex の内部型は line/messages.ts が公開する型をそのまま再利用する（型の二重定義を作らない）。
// - **文面の規律**: 「再連携してください」の誘導は認可の失効（token_invalid）と未連携
//   （not_linked）にのみ用いる。復号失敗（crypto_error）は運用側の鍵事故でありオーナーの
//   操作では解決しないため、本モジュールにも再連携を促す crypto_error 用の文面を置かない
//   （tasks.md Implementation Notes 2.2 の申し送り）。

import type { GbpSessionRow } from '@fwlm/db';
import type { LineMessage } from '../line/client.js';
import type {
  FlexBoxContent,
  FlexBubbleContents,
  FlexCarouselContents,
} from '../line/messages.js';
import { encodeGbpPostback } from './postback.js';

/** 選択・状態提示の対象店舗（index は配列順＝セッションのスナップショット順）。 */
export interface GbpSelectableStore {
  id: string;
  name: string;
}

/** 連携状態の提示単位（Req 2.5）。 */
export interface GbpStatusEntry {
  storeId: string;
  name: string;
  linked: boolean;
}

/**
 * Flex カルーセルの提示上限。LINE の上限（12）より厳しい 10 を本サービスの契約とする
 * （onboarding の候補カルーセルと同一。呼び出し側は必ずこの件数以内に丸めて渡す）。
 */
export const MAX_SELECTABLE_STORES = 10;

const LINKED_COLOR = '#1DB446';
const MUTED_COLOR = '#888888';

function assertWithinCarouselContract(count: number, fnName: string): void {
  if (count === 0) {
    throw new Error(`${fnName}: stores must not be empty`);
  }
  if (count > MAX_SELECTABLE_STORES) {
    throw new Error(
      `${fnName}: stores exceeds contract limit of ${MAX_SELECTABLE_STORES} (got ${count})`,
    );
  }
}

function textMessage(text: string): LineMessage {
  return { type: 'text', text };
}

function bubbleMessage(input: {
  altText: string;
  title: string;
  lines: readonly string[];
  buttons: readonly FlexBoxContent[];
}): LineMessage {
  const body: FlexBoxContent[] = [
    { type: 'text', text: input.title, weight: 'bold', size: 'md', wrap: true },
    ...input.lines.map(
      (line): FlexBoxContent => ({
        type: 'text',
        text: line,
        size: 'sm',
        color: '#666666',
        wrap: true,
      }),
    ),
  ];

  const contents: FlexBubbleContents = {
    type: 'bubble',
    size: 'kilo',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: input.buttons },
  };

  return { type: 'flex', altText: input.altText, contents };
}

const CONNECT_BUTTON: FlexBoxContent = {
  type: 'button',
  style: 'primary',
  color: LINKED_COLOR,
  action: {
    type: 'postback',
    label: 'Google と連携する',
    data: encodeGbpPostback({ action: 'g_connect' }),
    displayText: 'Google と連携する',
  },
};

const STATUS_BUTTON: FlexBoxContent = {
  type: 'button',
  style: 'secondary',
  action: {
    type: 'postback',
    label: '連携状態を確認',
    data: encodeGbpPostback({ action: 'g_status' }),
    displayText: '連携状態を確認',
  },
};

function disconnectButton(storeId: string): FlexBoxContent {
  return {
    type: 'button',
    style: 'secondary',
    action: {
      type: 'postback',
      label: '連携を解除',
      data: encodeGbpPostback({ action: 'g_disconnect', storeId }),
      displayText: '連携を解除',
    },
  };
}

/**
 * Req 1.2: 対象店舗の認可手続きへの誘導。認可 URL は state を含むワンタイム値のため、
 * このメッセージは生成のたびに新しい URL を持つ（使い回してはならない）。
 */
export function buildGbpAuthorizeMessage(input: {
  storeName: string;
  authorizeUrl: string;
}): LineMessage {
  const contents: FlexBubbleContents = {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: 'Google との連携', weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: input.storeName, size: 'sm', wrap: true },
        {
          type: 'text',
          text:
            '下のボタンから Google にログインし、お店のビジネスプロフィールへのアクセスを許可してください。' +
            '連携が完了すると、LINE から Google 投稿の作成とクチコミ返信ができるようになります。',
          size: 'sm',
          color: '#666666',
          wrap: true,
        },
        {
          type: 'text',
          text: '※お店を管理している Google アカウントでログインしてください。',
          size: 'xs',
          color: MUTED_COLOR,
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: LINKED_COLOR,
          action: { type: 'uri', label: 'Google と連携する', uri: input.authorizeUrl },
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: `「${input.storeName}」の Google 連携を開始します。トークのボタンから認可へお進みください。`,
    contents,
  };
}

/**
 * Req 1.3: 複数店舗を持つオーナーへの連携対象の選択。index は呼び出し側がセッションへ
 * 保存したスナップショットの並び順と一致していなければならない。
 */
export function buildGbpStorePickerMessage(
  stores: readonly GbpSelectableStore[],
): LineMessage {
  assertWithinCarouselContract(stores.length, 'buildGbpStorePickerMessage');

  const contents: FlexCarouselContents = {
    type: 'carousel',
    contents: stores.map(
      (store, index): FlexBubbleContents => ({
        type: 'bubble',
        size: 'kilo',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            { type: 'text', text: store.name, weight: 'bold', size: 'md', wrap: true },
            {
              type: 'text',
              text: 'このお店を Google と連携します。',
              size: 'sm',
              color: '#666666',
              wrap: true,
            },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: LINKED_COLOR,
              action: {
                type: 'postback',
                label: 'このお店を連携',
                data: encodeGbpPostback({ action: 'g_pick_store', index }),
                displayText: `${store.name} を連携`,
              },
            },
          ],
        },
      }),
    ),
  };

  return {
    type: 'flex',
    altText: '連携するお店を選択してください。',
    contents,
  };
}

/**
 * Req 1.1: Place 確定済み（日次サマリーが稼働している）店舗が無いオーナーには
 * 連携の誘導自体を提示しない。代わりに先に店舗特定を完了させる案内を返す。
 */
export function buildGbpNoEligibleStoreMessage(): LineMessage {
  return textMessage(
    'Google 連携をご利用いただけるお店がまだありません。\n' +
      '先にお店の登録（店舗特定）を完了してください。登録が済むと、Google 投稿とクチコミ返信の連携をご案内できます。',
  );
}

/** 対象店舗がすでに連携済みのときの状態提示（再認可を促さない）。 */
export function buildGbpAlreadyLinkedMessage(storeId: string, storeName: string): LineMessage {
  return bubbleMessage({
    altText: `「${storeName}」はすでに Google と連携済みです。`,
    title: 'すでに連携済みです',
    lines: [
      `「${storeName}」は Google ビジネスプロフィールと連携済みです。`,
      '連携を切り替えたい場合は、いったん連携を解除してからやり直してください。',
    ],
    buttons: [disconnectButton(storeId), STATUS_BUTTON],
  });
}

/** Req 2.5: 店舗ごとの連携有無と、連携／解除の操作ボタンを提示する。 */
export function buildGbpStatusMessage(entries: readonly GbpStatusEntry[]): LineMessage {
  assertWithinCarouselContract(entries.length, 'buildGbpStatusMessage');

  const contents: FlexCarouselContents = {
    type: 'carousel',
    contents: entries.map(
      (entry): FlexBubbleContents => ({
        type: 'bubble',
        size: 'kilo',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            { type: 'text', text: entry.name, weight: 'bold', size: 'md', wrap: true },
            {
              type: 'text',
              text: entry.linked ? 'Google 連携: 連携済み' : 'Google 連携: 未連携',
              size: 'sm',
              color: entry.linked ? LINKED_COLOR : MUTED_COLOR,
              wrap: true,
            },
            {
              type: 'text',
              text: entry.linked
                ? 'このお店では Google 投稿の作成とクチコミ返信をご利用いただけます。'
                : '連携すると、Google 投稿の作成とクチコミ返信が LINE から使えるようになります。',
              size: 'sm',
              color: '#666666',
              wrap: true,
            },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: entry.linked ? [disconnectButton(entry.storeId)] : [CONNECT_BUTTON],
        },
      }),
    ),
  };

  return {
    type: 'flex',
    altText: `お店ごとの Google 連携状態をお送りしました（${entries.length}件）。`,
    contents,
  };
}

/**
 * Req 2.4: 連携解除の完了案内（未連携状態＝連携誘導の表示へ戻す）。
 * storeName は所有検証済みの一覧から解決できた場合のみ渡される。
 */
export function buildGbpDisconnectedMessage(storeName: string | null): LineMessage {
  const target = storeName === null ? 'お店' : `「${storeName}」`;
  return bubbleMessage({
    altText: `${target}の Google 連携を解除しました。`,
    title: 'Google 連携を解除しました',
    lines: [
      `${target}に保存していた Google の認可情報を削除しました。`,
      'Google 投稿の作成とクチコミ返信は、再度連携するまでご利用いただけません。',
    ],
    buttons: [CONNECT_BUTTON],
  });
}

/**
 * 対象店舗が未連携（または当該オーナーの店舗ではない）ときの案内。
 * 存在の有無を区別せず同一文面にすることで、他オーナーの店舗の存在を推測させない。
 */
export function buildGbpNotLinkedMessage(): LineMessage {
  return bubbleMessage({
    altText: 'このお店はまだ Google と連携していません。',
    title: 'まだ連携していません',
    lines: [
      '対象のお店は Google と連携していないため、解除する認可情報はありません。',
      '連携すると、Google 投稿の作成とクチコミ返信が LINE から使えるようになります。',
    ],
    buttons: [CONNECT_BUTTON, STATUS_BUTTON],
  });
}

/** セッションの有効期限切れ（30 分）。行は破棄済みで、やり直しの導線のみを案内する。 */
export function buildGbpSessionExpiredMessage(): LineMessage {
  return bubbleMessage({
    altText: '操作の有効期限が切れました。もう一度お試しください。',
    title: '有効期限が切れました',
    lines: [
      'しばらく操作がなかったため、進行中の手続きを終了しました。',
      'お手数ですが、もう一度最初からお試しください。',
    ],
    buttons: [CONNECT_BUTTON, STATUS_BUTTON],
  });
}

/**
 * 古い選択肢（再提示前のカルーセル・対象外になった店舗）からの操作。
 * 何も実行せず、選び直しの導線のみを案内する。
 */
export function buildGbpStaleSelectionMessage(): LineMessage {
  return bubbleMessage({
    altText: 'この選択肢は使用できません。もう一度お選びください。',
    title: 'この選択肢は使用できません',
    lines: [
      '選択されたお店が見つからないため、操作を中止しました。',
      'お手数ですが、もう一度連携するお店を選び直してください。',
    ],
    buttons: [CONNECT_BUTTON, STATUS_BUTTON],
  });
}

/** 認可の開始が行えなかったとき（対象店舗が操作の直前に対象外になった等）の案内。 */
export function buildGbpConnectUnavailableMessage(): LineMessage {
  return textMessage(
    'Google 連携の開始に失敗しました。\n' +
      'お手数ですが、時間をおいてもう一度お試しください。',
  );
}

/** 進行中の手続きの取りやめ。 */
export function buildGbpCancelledMessage(): LineMessage {
  return bubbleMessage({
    altText: '手続きを取りやめました。',
    title: '取りやめました',
    lines: ['進行中の手続きを取りやめました。いつでもやり直せます。'],
    buttons: [STATUS_BUTTON],
  });
}

/**
 * 本 spec の投稿（機能2）・クチコミ返信（機能1-b）フローは task 4.1 / 4.2 で解禁される。
 * それまでの間、当該 action が届いた場合は何も実行せず現在利用できる操作のみを案内する。
 */
export function buildGbpFlowNotAvailableMessage(): LineMessage {
  return bubbleMessage({
    altText: 'Google 投稿の作成とクチコミ返信は現在ご利用いただけません。',
    title: 'この操作は準備中です',
    lines: [
      'Google 投稿の作成とクチコミ返信は現在準備中です。',
      'いまは Google との連携の設定・確認をご利用いただけます。',
    ],
    buttons: [STATUS_BUTTON],
  });
}

/**
 * 現在の状態の案内（stale postback・想定外テキストの安全側フォールバック）。
 * 「案内を再送する」だけで、いかなる状態遷移も副作用も伴わない。
 */
export function buildGbpCurrentStateMessage(session: GbpSessionRow | null): LineMessage {
  if (session === null) {
    return bubbleMessage({
      altText: '進行中の手続きはありません。',
      title: '進行中の手続きはありません',
      lines: ['現在進行中の手続きはありません。下のボタンから操作を選んでください。'],
      buttons: [CONNECT_BUTTON, STATUS_BUTTON],
    });
  }

  if (session.flow === 'connect' && session.stage === 'await_store') {
    return bubbleMessage({
      altText: '連携するお店を選択してください。',
      title: 'お店を選択してください',
      lines: ['連携するお店をトーク内のボタンから選択してください。'],
      buttons: [CONNECT_BUTTON],
    });
  }

  if (session.flow === 'connect' && session.stage === 'await_callback') {
    return bubbleMessage({
      altText: 'Google の認可画面での操作をお待ちしています。',
      title: 'Google での操作をお待ちしています',
      lines: [
        '先ほどお送りしたボタンから Google にログインし、アクセスを許可してください。',
        'やり直す場合は、下のボタンからもう一度連携を開始してください。',
      ],
      buttons: [CONNECT_BUTTON],
    });
  }

  // 投稿・返信フロー（task 4.1 / 4.2 が実装する stage）は本タスクでは開始されない。
  // 将来それらの stage が到達した場合も、状態を壊さない汎用案内へ倒す。
  return bubbleMessage({
    altText: '進行中の手続きがあります。トーク内のボタンから操作してください。',
    title: '進行中の手続きがあります',
    lines: ['トーク内のボタンから操作を続けてください。取りやめる場合は連携状態の確認へお進みください。'],
    buttons: [STATUS_BUTTON],
  });
}

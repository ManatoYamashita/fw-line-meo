// 一括発信のメッセージの組み立て（line-crosspost design.md「System Flows」・Requirement 1〜7）。
//
// - 色は @fwlm/design-tokens の lineColors だけを使う（直書きの hex は scripts/check-design-tokens.sh が禁じる）。
// - altText は通知・読み上げに出る。何のメッセージか分かる文にする（400 字以内）。
// - ボタンのラベルは Flex 40 字・クイックリプライ 20 字以内。
// - 投稿文の全文は Flex の本文に出す（確認できる形・Req 4.1）。ログには出さない。
// - 内部の ID・トークン・外部 API のエラー本文は出さない（Req 7.4）。

import type { CrosspostDeliveryContext, CrosspostDeliveryRow, CrosspostDraftRow } from '@fwlm/db';
import { lineColors } from '@fwlm/design-tokens';
import type { LineMessage } from '../line/client.js';
import type {
  FlexBoxContent,
  FlexBubbleContents,
  FlexButtonComponent,
  FlexPostbackAction,
  QuickReplyItem,
} from '../line/flex-types.js';
import type { Availability, ContentIssue } from './adapters/types.js';
import {
  charLength,
  CLIPBOARD_MAX_CHARS,
  DESTINATION_LABELS,
  DESTINATION_ORDER,
  FAILURE_REASON_LABELS,
  MAX_DELIVERY_ATTEMPTS,
  type CrosspostDestination,
} from './domain.js';
import type { IntakeRejection } from './intake.js';
import type { AvailabilityMap } from './publisher.js';
import { choiceToDestinations, encodeCrosspostPostback, type CrosspostPostback, type DestinationChoice } from './postback.js';

const ALT_TEXT_MAX = 400;

function postback(label: string, data: CrosspostPostback, displayText = label): FlexPostbackAction {
  return { type: 'postback', label, data: encodeCrosspostPostback(data), displayText };
}

function button(action: FlexButtonComponent['action'], style: 'primary' | 'secondary' = 'secondary'): FlexButtonComponent {
  return style === 'primary'
    ? { type: 'button', style, color: lineColors.action, height: 'sm', action }
    : { type: 'button', style, height: 'sm', action };
}

function text(value: string, options: { bold?: boolean; size?: string; color?: string } = {}): FlexBoxContent {
  return {
    type: 'text',
    text: value,
    wrap: true,
    size: options.size ?? 'sm',
    ...(options.bold ? { weight: 'bold' as const } : {}),
    color: options.color ?? lineColors.body,
  };
}

function bubble(input: {
  title: string;
  lines: readonly FlexBoxContent[];
  buttons: readonly FlexBoxContent[];
  size?: 'kilo' | 'mega';
}): FlexBubbleContents {
  return {
    type: 'bubble',
    size: input.size ?? 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [text(input.title, { bold: true, size: 'md', color: lineColors.body }), ...input.lines],
    },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: input.buttons },
  };
}

function flex(altText: string, contents: unknown): LineMessage {
  return { type: 'flex', altText: altText.slice(0, ALT_TEXT_MAX), contents };
}

function quickReplies(items: readonly FlexPostbackAction[]): { items: QuickReplyItem[] } {
  return { items: items.map((action) => ({ type: 'action', action })) };
}

function plain(textValue: string, replies?: readonly FlexPostbackAction[]): LineMessage {
  return replies === undefined || replies.length === 0
    ? { type: 'text', text: textValue }
    : { type: 'text', text: textValue, quickReply: quickReplies(replies) };
}

/** 受け取り中のクイックリプライ（下書きを作る・やめる）。 */
function collectingReplies(draftId: string): FlexPostbackAction[] {
  return [postback('下書きを作る', { action: 'x_gen', draftId }), postback('やめる', { action: 'x_cancel', draftId })];
}

// =====================================================================
// 開始・店舗の選択・受け取り
// =====================================================================

/** 投稿先の準備の状況を 1 行ずつ（Req 1.3・5.2）。 */
export function describeAvailability(destination: CrosspostDestination, availability: Availability): string {
  const label = DESTINATION_LABELS[destination];
  switch (availability.kind) {
    case 'available':
      return `${label}: 投稿できます`;
    case 'needs_connection':
      return `${label}: 連携すると投稿できます`;
    case 'needs_relink':
      return `${label}: 連携の期限が切れています。もう一度連携してください`;
    case 'not_ready':
      return `${label}: 準備中です（文をコピーして、${label} のアプリから投稿できます）`;
    case 'unsupported_content':
      return `${label}: ${CONTENT_ISSUE_LABELS[availability.issue]}`;
  }
}

const CONTENT_ISSUE_LABELS: Readonly<Record<ContentIssue, string>> = {
  media_required: '写真が必要です',
  media_aspect_ratio: 'この写真の縦横の比率では投稿できません',
  media_size: 'この写真の大きさでは投稿できません',
  media_not_deliverable: '写真付きの投稿は準備中です（文をコピーして投稿できます）',
  posting_not_permitted: 'この店舗では投稿の権限がありません',
};

export function buildStartMessage(input: { draftId: string; storeName: string; availability: AvailabilityMap }): LineMessage {
  const anyAvailable = DESTINATION_ORDER.some((d) => input.availability[d].kind === 'available');
  const lines = [
    `「${input.storeName}」の投稿を作ります。`,
    '写真（1 枚）と、伝えたいこと（新メニュー・お知らせなど）を、このトークに送ってください。何通に分けても大丈夫です。',
    '送り終わったら「下書きを作る」を押してください。Instagram 用と Google 用の文を作ります。',
    '',
    ...DESTINATION_ORDER.map((d) => `・${describeAvailability(d, input.availability[d])}`),
    ...(anyAvailable
      ? []
      : ['', 'いまは投稿先へ直接は投稿できませんが、作った文をコピーして、それぞれのアプリから投稿できます。']),
    '',
    '投稿は、最後にあなたが「投稿する」を押したときだけ行います。',
  ];
  return plain(lines.join('\n'), collectingReplies(input.draftId));
}

export function buildStorePickerMessage(stores: readonly { id: string; name: string }[]): LineMessage {
  return flex(
    '投稿を作る店舗を選んでください。',
    bubble({
      title: 'どの店舗の投稿を作りますか',
      lines: [text('投稿を作る店舗を選んでください。', { color: lineColors.description })],
      buttons: stores.map((store) =>
        button(postback(truncateLabel(store.name, 40), { action: 'x_start', storeId: store.id }, `${store.name}の投稿を作る`)),
      ),
    }),
  );
}

export function buildOpenDraftExistsMessage(input: { storeName: string; requestedStoreId: string | null }): LineMessage {
  return flex(
    '作成中の投稿があります。続けるか、新しく作るかを選んでください。',
    bubble({
      title: '作成中の投稿があります',
      lines: [
        text(`「${input.storeName}」の投稿を作っている途中です。`),
        text('新しく作ると、作成中の内容（写真・文）は消えます。', { color: lineColors.description }),
      ],
      buttons: [
        button(postback('続きから', { action: 'x_resume' }), 'primary'),
        button(postback('新しく作る', { action: 'x_new', storeId: input.requestedStoreId })),
      ],
    }),
  );
}

export function buildReceivedMessage(input: {
  draftId: string;
  kind: 'photo' | 'photo_replaced' | 'text';
  hasPhoto: boolean;
  hasText: boolean;
}): LineMessage {
  const head =
    input.kind === 'photo'
      ? '写真を受け取りました。'
      : input.kind === 'photo_replaced'
        ? '写真を差し替えました（前の写真は使いません）。'
        : '受け取りました。';
  const next = !input.hasText
    ? '伝えたいことを文で送ってください。'
    : !input.hasPhoto
      ? '写真があれば送ってください（Instagram には写真が必要です）。送り終わったら「下書きを作る」を押してください。'
      : '続きがあれば送ってください。送り終わったら「下書きを作る」を押してください。';
  return plain(`${head}\n${next}`, collectingReplies(input.draftId));
}

export function buildPhotoSetNoticeMessage(input: { draftId: string; total: number }): LineMessage {
  return plain(
    `写真を ${input.total} 枚受け取りました。投稿に使うのは 1 枚目の写真だけです（ほかの写真は使いません）。\n別の写真にしたいときは、その写真を 1 枚だけ送り直してください。`,
    collectingReplies(input.draftId),
  );
}

const INTAKE_REJECTION_LABELS: Readonly<Record<IntakeRejection, string>> = {
  unsupported_type: 'この形式の写真は使えません。JPEG か PNG の写真を送ってください。',
  too_large: '写真が大きすぎます。小さくして送り直してください。',
  too_small: '写真が小さすぎます。もう少し大きい写真を送ってください。',
  corrupt: '写真を読み取れませんでした。別の写真を送ってください。',
  gone: '写真を受け取れませんでした（送信が取り消された可能性があります）。もう一度送ってください。',
  external: 'この写真は受け取れませんでした。写真を直接送ってください。',
  temporary: '写真を受け取れませんでした。少し時間をおいて、もう一度送ってください。',
};

export function buildPhotoRejectedMessage(input: { draftId: string; reason: IntakeRejection }): LineMessage {
  return plain(`${INTAKE_REJECTION_LABELS[input.reason]}\nほかに送った内容はそのまま残っています。`, collectingReplies(input.draftId));
}

export function buildMaterialTooLongMessage(draftId: string): LineMessage {
  return plain(
    '文が長すぎるため、いまの文は受け取れませんでした（合計 2,000 字まで）。短くまとめて送ってください。',
    collectingReplies(draftId),
  );
}

export function buildMaterialAfterGenerationMessage(draftId: string): LineMessage {
  return plain(
    '下書きを作り始めた後に届いた文のため、下書きには入れていません。\n入れたいときは、下書きの「AIに直してもらう」から伝えてください。',
    [postback('下書きを見る', { action: 'x_view', draftId })],
  );
}

export function buildNeedMaterialMessage(draftId: string): LineMessage {
  return plain('伝えたいことを文で送ってから「下書きを作る」を押してください。', collectingReplies(draftId));
}

// =====================================================================
// 確認・修正
// =====================================================================

function destinationText(draft: CrosspostDraftRow, destination: CrosspostDestination): string | null {
  return destination === 'instagram' ? draft.instagram_text : draft.google_text;
}

function destinationBubble(input: {
  draft: CrosspostDraftRow;
  destination: CrosspostDestination;
  availability: Availability;
  hasPhoto: boolean;
}): FlexBubbleContents {
  const { draft, destination } = input;
  const body = destinationText(draft, destination);
  const label = DESTINATION_LABELS[destination];
  const base = { draftId: draft.id, revision: draft.revision, destination };
  const buttons: FlexBoxContent[] = [];
  if (body !== null && charLength(body) <= CLIPBOARD_MAX_CHARS) {
    buttons.push(button({ type: 'clipboard', label: '文をコピー', clipboardText: body }));
  }
  buttons.push(
    button(postback('自分で書き直す', { action: 'x_edit', ...base }, `${label}の文を自分で書き直す`)),
    button(postback('AIに直してもらう', { action: 'x_ai', ...base }, `${label}の文をAIに直してもらう`)),
    button(postback('作り直す', { action: 'x_regen', ...base }, `${label}の文を作り直す`)),
  );
  return bubble({
    title: `${label} 用`,
    lines: [
      text(body ?? '文を作れませんでした。「作り直す」を押してください。', {
        color: body === null ? lineColors.description : lineColors.body,
      }),
      text(input.hasPhoto ? '写真: あり（1 枚）' : '写真: なし', { size: 'xs', color: lineColors.caption }),
      text(describeAvailability(destination, input.availability), { size: 'xs', color: lineColors.caption }),
    ],
    buttons,
  });
}

/** 使える投稿先の組み合わせ（Req 5.1）。 */
export function availableChoices(draft: CrosspostDraftRow, availability: AvailabilityMap): DestinationChoice[] {
  const ok = (d: CrosspostDestination): boolean =>
    availability[d].kind === 'available' && destinationText(draft, d) !== null;
  const choices: DestinationChoice[] = [];
  if (ok('instagram') && ok('google')) choices.push('both');
  if (ok('instagram')) choices.push('instagram');
  if (ok('google')) choices.push('google');
  return choices;
}

const CHOICE_LABELS: Readonly<Record<DestinationChoice, string>> = {
  both: 'Instagram と Google に投稿',
  instagram: 'Instagram だけに投稿',
  google: 'Google だけに投稿',
};

export function buildReviewMessage(input: {
  draft: CrosspostDraftRow;
  storeName: string;
  availability: AvailabilityMap;
  hasPhoto: boolean;
  /** Google の連携の入口（GBP の会話）が使えるか。使えるときだけ連携のボタンを出す。 */
  googleConnectAvailable: boolean;
}): LineMessage {
  const choices = availableChoices(input.draft, input.availability);
  const chooseButtons: FlexBoxContent[] = choices.map((choice, index) =>
    button(
      postback(CHOICE_LABELS[choice], {
        action: 'x_conf',
        draftId: input.draft.id,
        revision: input.draft.revision,
        choice,
      }),
      index === 0 ? 'primary' : 'secondary',
    ),
  );
  if (input.googleConnectAvailable && input.availability.google.kind === 'needs_connection') {
    chooseButtons.push(
      button({ type: 'postback', label: 'Google と連携する', data: 'a=g_connect', displayText: 'Google と連携する' }),
    );
  }
  chooseButtons.push(button(postback('やめる', { action: 'x_cancel', draftId: input.draft.id })));

  const chooseBubble = bubble({
    title: '投稿先を選ぶ',
    lines: [
      text(
        choices.length > 0
          ? '投稿先を選ぶと、最後の確認を出します。まだ投稿はしません。'
          : 'いまは直接投稿できる投稿先がありません。文をコピーして、それぞれのアプリから投稿できます。',
      ),
      ...DESTINATION_ORDER.map((d) =>
        text(`・${describeAvailability(d, input.availability[d])}`, { size: 'xs', color: lineColors.description }),
      ),
    ],
    buttons: chooseButtons,
  });

  return flex(`「${input.storeName}」の投稿の下書きができました。内容を確認してください。`, {
    type: 'carousel',
    contents: [
      ...DESTINATION_ORDER.map((destination) =>
        destinationBubble({
          draft: input.draft,
          destination,
          availability: input.availability[destination],
          hasPhoto: input.hasPhoto,
        }),
      ),
      chooseBubble,
    ],
  });
}

export function buildInputModeMessage(input: {
  draftId: string;
  destination: CrosspostDestination;
  mode: 'ai_revision' | 'manual';
}): LineMessage {
  const label = DESTINATION_LABELS[input.destination];
  const body =
    input.mode === 'ai_revision'
      ? `${label} の文をどう直したいかを送ってください。\n例:「もっと短く」「絵文字を減らして」「やわらかい言い方に」\n伝えた内容は事実として使います。書いていないことは加えません。`
      : `${label} に投稿する文を、そのまま送ってください。送った文を AI で書き換えずに使います。\n「文をコピー」で写した下書きを直して送ることもできます。`;
  return plain(body, [postback('直すのをやめる', { action: 'x_view', draftId: input.draftId })]);
}

export function buildReviewHintMessage(draftId: string): LineMessage {
  return plain(
    '文を直すときは、下書きの「自分で書き直す」か「AIに直してもらう」を押してから送ってください。\n送った文は、そのままでは下書きに入りません。',
    [postback('下書きを見る', { action: 'x_view', draftId })],
  );
}

export function buildManualTextRejectedMessage(input: {
  draftId: string;
  destination: CrosspostDestination;
  issue: 'empty' | 'too_long_for_destination' | 'too_many_hashtags';
}): LineMessage {
  const label = DESTINATION_LABELS[input.destination];
  const reason =
    input.issue === 'too_long_for_destination'
      ? `${label} に投稿できる長さを超えています。短くして送ってください。`
      : input.issue === 'too_many_hashtags'
        ? `${label} のハッシュタグは 30 個までです。減らして送ってください。`
        : '文が空です。投稿する文を送ってください。';
  return plain(reason, [postback('直すのをやめる', { action: 'x_view', draftId: input.draftId })]);
}

export function buildGenerationFailedMessage(draftId: string): LineMessage {
  return plain('文を作れませんでした。送った内容はそのまま残っています。もう一度お試しください。', [
    postback('下書きを見る', { action: 'x_view', draftId }),
  ]);
}

// =====================================================================
// 最終確認・承認
// =====================================================================

function excerpt(value: string, max = 60): string {
  const chars = [...value.replace(/\s+/g, ' ').trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
}

/** 写真の向き（店主が取り違えに気づく手掛かり）。 */
export function describeOrientation(width: number, height: number): string {
  const ratio = width / height;
  if (ratio > 1.1) return '横長';
  if (ratio < 0.9) return '縦長';
  return '正方形に近い';
}

/** 最終確認で示す写真（店主が送った写真のメッセージの quoteToken と寸法）。quoteToken が無い写真は最終確認を出さない。 */
export interface ConfirmPhoto {
  width: number;
  height: number;
  quoteToken: string;
}

/**
 * 最終確認（Req 5.3, 5.8, 8.7）。写真があるときは、**店主が送った写真のメッセージそのものを引用する**テキストを
 * 先に置く（quoteToken・公開の URL を作らずに、公開する写真を目で確かめられる）。引用できない写真では、この
 * メッセージを作らない（flows が buildPhotoResendRequiredMessage を返す・Req 5.9）。
 */
export function buildConfirmMessage(input: {
  draft: CrosspostDraftRow;
  storeName: string;
  choice: DestinationChoice;
  photo: ConfirmPhoto | null;
}): LineMessage[] {
  const destinations = choiceToDestinations(input.choice);
  const label = destinations.map((d) => DESTINATION_LABELS[d]).join(' と ');
  const photo = input.photo;
  const photoLine = photo === null ? '写真: なし' : `写真: 上で引用した写真（${describeOrientation(photo.width, photo.height)}）`;
  const messages: LineMessage[] = [];
  if (photo !== null) {
    messages.push({
      type: 'text',
      text: `この写真を投稿します（${describeOrientation(photo.width, photo.height)}）。違う写真のときは、その写真を送り直してから確認し直してください。`,
      quoteToken: photo.quoteToken,
    });
  }
  messages.push(
    flex(
      `「${input.storeName}」の投稿を ${label} に投稿します。よろしければ「投稿する」を押してください。`,
      bubble({
        title: `${label} に投稿します`,
        lines: [
          text(`店舗: ${input.storeName}`, { color: lineColors.description }),
          text(photoLine, { color: lineColors.description }),
          ...destinations.map((d) => text(`${DESTINATION_LABELS[d]}: ${excerpt(destinationText(input.draft, d) ?? '')}`)),
          ...(photo !== null
            ? [text('写真にお客様の顔などが写っていないか、もう一度ご確認ください。', { size: 'xs', color: lineColors.caption })]
            : []),
          text('「投稿する」を押すと公開されます。', { size: 'xs', color: lineColors.caption }),
        ],
        buttons: [
          button(
            postback(
              '投稿する',
              { action: 'x_ok', draftId: input.draft.id, revision: input.draft.revision, choice: input.choice },
              `${label}に投稿する`,
            ),
            'primary',
          ),
          button(postback('戻る', { action: 'x_view', draftId: input.draft.id })),
        ],
      }),
    ),
  );
  return messages;
}

/**
 * 写真を引用できない（引用の手掛かりが無い）ので、最終確認も承認もしない（Req 5.9）。送り直せば引用できる。
 */
export function buildPhotoResendRequiredMessage(draftId: string): LineMessage {
  return plain(
    '投稿する写真を、このトークの中で確かめられる形で受け取れていません。確かめていない写真は投稿しないため、お手数ですが写真をもう一度送ってから、投稿先を選び直してください。',
    [postback('下書きを見る', { action: 'x_view', draftId })],
  );
}

export function buildStaleMessage(draftId: string | null): LineMessage {
  return plain(
    '内容が変わったか、投稿先の状況が変わったため、このボタンでは投稿できません。最新の内容で確認してください。',
    draftId === null ? [] : [postback('最新の下書きを見る', { action: 'x_view', draftId })],
  );
}

export function buildNoOpenDraftMessage(): LineMessage {
  return plain('作成中の投稿はありません。', [
    postback('投稿を作る', { action: 'x_start', storeId: null }),
    postback('投稿の状況', { action: 'x_status' }),
  ]);
}

export function buildExpiredMessage(): LineMessage {
  return plain('時間が経ったため、作成中の投稿を閉じました（写真も消しました）。', [
    postback('新しく作る', { action: 'x_start', storeId: null }),
  ]);
}

export function buildCanceledMessage(): LineMessage {
  return plain('投稿の作成をやめました（写真も消しました）。', [postback('投稿を作る', { action: 'x_start', storeId: null })]);
}

// =====================================================================
// 結果・状況
// =====================================================================

function deliveryLines(row: CrosspostDeliveryRow): FlexBoxContent[] {
  const label = DESTINATION_LABELS[row.destination];
  switch (row.status) {
    case 'succeeded':
      return [text(`✓ ${label}: 投稿しました`, { bold: true })];
    case 'failed':
      return [
        text(`✕ ${label}: 投稿できませんでした`, { bold: true }),
        text(FAILURE_REASON_LABELS[row.failure_reason ?? 'rejected'], { size: 'xs', color: lineColors.description }),
        ...(row.retryable && row.attempt_count < MAX_DELIVERY_ATTEMPTS
          ? []
          : [text('この投稿先へは、もう一度は送りません。', { size: 'xs', color: lineColors.caption })]),
      ];
    case 'unknown':
      return [
        text(`？ ${label}: 投稿されたか確認できませんでした`, { bold: true }),
        text(
          `二重に投稿しないよう、自動では送り直しません。${label} で投稿されているかをご確認ください。`,
          { size: 'xs', color: lineColors.description },
        ),
      ];
    case 'in_progress':
      return [text(`… ${label}: 投稿しています`, { bold: true })];
    case 'queued':
      // 承認の直後はすぐ実行するので、結果の表示で待ちのまま見えるのは、処理が止まったときか別の操作の最中である。
      // 一度も送っていないことは確かなので、店主が選んで再開・取りやめできる（Req 6.11）。
      return [
        text(`－ ${label}: まだ送っていません`, { bold: true }),
        text('処理が途中で止まった可能性があります。今すぐ投稿するか、取りやめるかを選んでください。', {
          size: 'xs',
          color: lineColors.description,
        }),
      ];
    case 'canceled':
      return [text(`－ ${label}: 取りやめました（送っていません）`, { bold: true })];
  }
}

function deliveryButtons(row: CrosspostDeliveryRow): FlexBoxContent[] {
  const label = DESTINATION_LABELS[row.destination];
  if (row.status === 'failed' && row.retryable && row.attempt_count < MAX_DELIVERY_ATTEMPTS) {
    return [button(postback(`${label}にもう一度投稿`, { action: 'x_retry', deliveryId: row.id }), 'primary')];
  }
  if (row.status === 'queued') {
    return [
      button(postback(`${label}に今すぐ投稿する`, { action: 'x_run', deliveryId: row.id }), 'primary'),
      button(postback(`${label}への投稿を取りやめる`, { action: 'x_drop', deliveryId: row.id })),
    ];
  }
  if (row.status === 'unknown') {
    return [
      button(postback(`${label}に投稿されていた`, { action: 'x_seen', deliveryId: row.id, posted: true })),
      button(postback(`${label}に投稿されていなかった`, { action: 'x_seen', deliveryId: row.id, posted: false })),
    ];
  }
  return [];
}

export function buildResultMessage(input: {
  storeName: string;
  deliveries: readonly CrosspostDeliveryContext[];
}): LineMessage {
  const rows = input.deliveries.map((ctx) => ctx.delivery);
  const allOk = rows.length > 0 && rows.every((row) => row.status === 'succeeded');
  const buttons = rows.flatMap(deliveryButtons);
  buttons.push(button(postback('投稿の状況', { action: 'x_status' })));
  const summary = rows
    .map((row) => `${DESTINATION_LABELS[row.destination]}: ${STATUS_WORDS[row.status]}`)
    .join('、');
  return flex(
    `「${input.storeName}」の投稿の結果: ${summary}`,
    bubble({
      title: allOk ? '投稿しました' : '投稿の結果',
      lines: [
        text(`店舗: ${input.storeName}`, { color: lineColors.description }),
        ...rows.flatMap(deliveryLines),
        ...(allOk ? [text('反映まで少し時間がかかることがあります。', { size: 'xs', color: lineColors.caption })] : []),
      ],
      buttons,
    }),
  );
}

const STATUS_WORDS: Readonly<Record<CrosspostDeliveryRow['status'], string>> = {
  queued: 'まだ送っていません',
  in_progress: '投稿しています',
  succeeded: '投稿しました',
  failed: '投稿できませんでした',
  unknown: '確認できませんでした',
  canceled: '取りやめました',
};

export function buildStatusMessage(
  posts: readonly { draft: CrosspostDraftRow; storeName: string; deliveries: readonly CrosspostDeliveryRow[] }[],
): LineMessage {
  if (posts.length === 0) {
    return plain('まだ投稿はありません。', [postback('投稿を作る', { action: 'x_start', storeId: null })]);
  }
  return flex('最近の投稿の状況です。', {
    type: 'carousel',
    contents: posts.map((post) =>
      bubble({
        title: post.storeName,
        lines: [
          text(excerpt(post.draft.material_text, 40), { size: 'xs', color: lineColors.caption }),
          ...post.deliveries.flatMap(deliveryLines),
        ],
        buttons: post.deliveries.flatMap(deliveryButtons).concat([
          button(postback('投稿を作る', { action: 'x_start', storeId: null })),
        ]),
        size: 'kilo',
      }),
    ),
  });
}

export function buildPendingResultsIntroMessage(): LineMessage {
  return plain('お届けできていなかった投稿の結果です。');
}

export function buildNotRetryableMessage(): LineMessage {
  return plain('この投稿先は、いまは送り直せません。最新の状況を確認してください。', [
    postback('投稿の状況', { action: 'x_status' }),
  ]);
}

function truncateLabel(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}


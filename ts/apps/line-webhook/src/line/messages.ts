import type { StoreCandidate } from '@fwlm/db';
import { lineColors, lineLayout } from '@fwlm/design-tokens';
import { REPORT_LABELS } from '@fwlm/line-report';
import { encodePostback } from '../onboarding/stages.js';
import { attributionFooter, withAttributionAltText } from './attribution.js';
import type { LineMessage } from './client.js';
import type { FlexBubbleContents, FlexCarouselContents } from './flex-types.js';

// メッセージビルダー（design.md「MessageBuilders」）。
// Requirement 1.1: 友だち追加時の挨拶＋招待コード入力案内。
// Requirement 2.2: 無効な招待コード時の再入力案内（本モジュールは文言のみを提供する。
//   有効/無効の判定自体は ConversationHandlers・タスク 3.x の責務）。
// Requirement 3.1: 店舗候補一覧（最大 10 件・店名＋住所）を選択可能な Flex カルーセルで提示する。
// Requirement 4.1: 選択済み候補の確認＋確定/やり直しの意思確認を提示する。
// Requirement 4.3: 店舗特定完了案内（機能1 が利用可能になる旨）。
// Requirement 7.4: すべての案内文を日本語で提供する（文言をこのモジュールに集約する）。
// line-on-demand-report Requirement 2.5・2.10: ステータス案内と完了メッセージは、毎日の定期配信を
//   約束せず、変化があった日に知らせることとメニューから確認できることを案内する。
// line-on-demand-report Requirement 8.1（Issue #287）: Places のデータを載せる面は帰属表示を持つ。
//   本モジュールで対象になるのは、確定前の検索結果（店名と住所）を出す候補カルーセルと確認バブルの
//   2 つだけである。確定後の店舗名（stores.name）はオーナーが自ら選んで確定した自店の識別情報として
//   扱い、帰属表示を付けない（report/builders/notices.ts のコメントに同じ整理がある）。
//   どのビルダーが帰属表示を要るかの宣言と、その総和は test/line/messages.test.ts が固定する。
//
// 純粋関数のみ（design.md「MessageBuilders」制約）。I/O・副作用・LineMessenger/DB への
// 依存は一切持たない。postback data の符号化は onboarding/stages.ts の encodePostback を
// そのまま再利用し、ここで独自に符号化スキームを再実装しない。
// Flex の型は line/flex-types.ts に置く（レポートの組立と共有する）。

// PlacesSearchAdapter の契約（design.md: pageSize:10）と一致させる不変条件。
// LINE の Carousel 上限は 12 だが、本サービスの契約はさらに厳しい 10 件のため、
// それを超える呼び出しは（LINE の上限内であっても）契約違反として早期に落とす。
const MAX_CANDIDATES = 10;

// 詳細画面（store-detail LIFF）への導線の文言。完了メッセージのボタンとステータス案内で同じ語を使う。
const DETAIL_ACTION_LABEL = '詳細を見る';

// ステータス案内で挙げるレポートの導線。メニューのラベル（@fwlm/line-report の REPORT_LABELS）を
// そのまま引用し、オーナーが案内の語でメニューの区画を探せるようにする。
const REPORT_MENU_LABELS_QUOTED = [REPORT_LABELS.new_reviews, REPORT_LABELS.comparison, REPORT_LABELS.trend]
  .map((label) => `「${label}」`)
  .join('');

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
    size: lineLayout.bubbleSize,
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: lineLayout.itemGap,
      paddingAll: lineLayout.blockPadding,
      contents: [
        { type: 'text', text: candidate.name, weight: 'bold', size: lineLayout.bodySize, wrap: true },
        { type: 'text', text: candidate.address, size: lineLayout.descriptionSize, color: lineColors.caption, wrap: true },
      ],
    },
    // 候補の店名と住所は Places の検索結果そのものなので、帰属表示を持たせる（8.1・Issue #287）。
    // カルーセルのバブルは LINE の画面上でそれぞれ独立して見えるため、ポリシーの言う「同じ容器」は
    // バブル 1 つであり、帰属表示はカルーセルに 1 つではなくバブルごとに 1 つ置く。
    footer: attributionFooter([
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
    ]),
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
 * ステータス案内（line-on-demand-report Requirement 2.5・2.10、design.md「StatusGuidance と AppBoundary」）。
 * 店舗特定済みオーナーの「ステータス確認」やレポート以外の操作に返す、1 文 1 行・3 行のテキスト。
 * 店舗の登録が完了していること、メニューから 3 つのレポートと詳細画面を確認できること、
 * 変化があった日に配信時刻に知らせることを案内する。
 * Requirement 4.6（「店舗特定済み」到達後の入力に対する固定案内）もこの文言で兼ねる。
 * Requirement 4.3 の完了直後メッセージ（buildCompletionMessage）とは異なる場面
 * （「たった今完了した」ではなく「すでに完了済み」）のための、意図的に別立てのメッセージ。
 * 配信時刻はオーナーごとの値（owners.delivery_hour）なので、固定の時刻を書かない（Requirement 1.9）。
 */
export function buildStatusGuidanceMessage(): LineMessage {
  return {
    type: 'text',
    text:
      '店舗の登録は完了しています。\n' +
      `メニューの${REPORT_MENU_LABELS_QUOTED}でレポートを、「${DETAIL_ACTION_LABEL}」で詳細画面をご確認いただけます。\n` +
      '新着口コミや順位の変化があった日は、配信時刻にこのトークでお知らせします。',
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
    altText: withAttributionAltText(
      `店舗候補が${candidates.length}件見つかりました。トークから該当する店舗を選択してください。`,
    ),
    contents,
  };
}

/** Requirement 4.1: 選択済み候補の確認＋確定/やり直しの意思確認。 */
export function buildConfirmationMessage(candidate: StoreCandidate): LineMessage {
  const contents: FlexBubbleContents = {
    type: 'bubble',
    size: lineLayout.bubbleSize,
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: lineLayout.itemGap,
      paddingAll: lineLayout.blockPadding,
      contents: [
        { type: 'text', text: 'この店舗でよろしいですか？', weight: 'bold', size: lineLayout.bodySize, wrap: true },
        { type: 'text', text: candidate.name, size: lineLayout.bodySize, wrap: true },
        { type: 'text', text: candidate.address, size: lineLayout.descriptionSize, color: lineColors.caption, wrap: true },
      ],
    },
    // 候補の店名と住所は Places の検索結果そのものなので、帰属表示を持たせる（8.1・Issue #287）。
    // 2 つのボタンは横並びのままにし、それを 1 つの部品として帰属表示の上へ積む。
    footer: attributionFooter([
      {
        type: 'box',
        layout: 'horizontal',
        spacing: lineLayout.itemGap,
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
    ]),
  };

  return {
    type: 'flex',
    altText: withAttributionAltText(`「${candidate.name}」でよろしいですか？内容をご確認のうえ確定してください。`),
    contents,
  };
}

/**
 * Requirement 4.3: 店舗特定完了案内（機能1＝競合店との比較などのレポートが利用可能になる旨）。
 * 長いオンボーディングの完走を祝う装飾 Flex とし、機能1の詳細（store-detail LIFF）への
 * 明確な導線ボタン（URI アクション）を添える（Issue #21・完了演出のリッチ化）。
 * storeDetailUrl は環境依存のため呼び出し側（config 由来）から注入する。
 * 毎日の定期配信は約束せず、変化があった日に知らせることとメニューから確認できることを案内する
 * （line-on-demand-report Requirement 2.10）。
 */
export function buildCompletionMessage(storeDetailUrl: string): LineMessage {
  const contents: FlexBubbleContents = {
    type: 'bubble',
    size: lineLayout.bubbleSize,
    styles: {
      body: { backgroundColor: lineColors.successBackground },
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: lineLayout.sectionGap,
      paddingAll: lineLayout.blockPadding,
      contents: [
        {
          type: 'text',
          text: '🎉 登録が完了しました',
          weight: 'bold',
          size: lineLayout.titleSize,
          align: 'center',
          // 見出しはアクション色と同値の緑を使わない。淡緑の面の上では読みづらいうえ、
          // 同じバブルの CTA と同色になり、押せない見出しが押せるように読まれる。
          // 緑はこのバブルでは CTA ただ 1 箇所が持つ。
          color: lineColors.body,
          wrap: true,
        },
        {
          type: 'text',
          text: 'お店の登録が完了しました。これで機能1（競合店との比較などのレポート）がご利用いただけます。',
          size: lineLayout.descriptionSize,
          color: lineColors.body,
          align: 'center',
          wrap: true,
          margin: lineLayout.sectionGap,
        },
        {
          type: 'text',
          text: '新着口コミや順位の変化があった日にお知らせします。レポートはメニューからいつでもご確認いただけます。',
          size: lineLayout.noteSize,
          color: lineColors.caption,
          align: 'center',
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: lineLayout.itemGap,
      paddingAll: lineLayout.blockPadding,
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: lineColors.action,
          // 高さも明示する。既定に委ねると、LINE 側の既定値が変わったとき
          // 同じ導線を持つ別のバブルと片方だけ動く。
          height: lineLayout.actionHeight,
          action: {
            type: 'uri',
            // リッチメニューの「詳細を見る」と語彙を揃える（同じ LIFF 画面へ飛ぶ）。
            label: DETAIL_ACTION_LABEL,
            uri: storeDetailUrl,
          },
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: '店舗の登録が完了しました。機能1（競合店との比較などのレポート）がご利用いただけます。',
    contents,
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
  const contents: FlexBubbleContents = {
    type: 'bubble',
    size: lineLayout.bubbleSize,
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: lineLayout.itemGap,
      paddingAll: lineLayout.blockPadding,
      contents: [
        { type: 'text', text: '確定できませんでした', weight: 'bold', size: lineLayout.bodySize, wrap: true },
        {
          type: 'text',
          text:
            'この店舗はすでに別のオーナー様の店舗として登録されているため、確定できませんでした。' +
            '心当たりがない場合は、お手数ですが運営までお問い合わせください。',
          size: lineLayout.descriptionSize,
          color: lineColors.description,
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: lineLayout.itemGap,
      paddingAll: lineLayout.blockPadding,
      contents: [
        {
          type: 'button',
          style: 'primary',
          action: {
            type: 'postback',
            label: '別のお店でやり直す',
            data: encodePostback({ kind: 'restart' }),
            displayText: 'やり直す',
          },
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: 'この店舗はすでに登録されているため確定できませんでした。別のお店でやり直せます。',
    contents,
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
 *
 * レポートの対象店舗を決めた後の失敗（line-on-demand-report Requirement 7.5）では、storeName に店舗名を渡す。
 * 先頭の行を「「店舗名」のレポートを表示できませんでした。」に替え、残りの行（サポートコード・再試行・問い合わせ）は
 * 汎用の文言と同じにする。行を足さないのは、テキスト案内を 3 行ほどに収めるため（design-language §7.16）。
 * 店舗名は、レポートの案内（report/builders/notices.ts）と同じく省略せずに「」で括る。
 * 出すのは店舗名とサポートコードだけで、内部の詳細（例外の種別や本文）を受け取る引数を持たない。
 */
export function buildInternalErrorRetryMessage(supportCode?: string, storeName?: string): LineMessage {
  return {
    type: 'text',
    text:
      (storeName
        ? `「${storeName}」のレポートを表示できませんでした。\n`
        : '申し訳ございません、処理中にエラーが発生しました。\n') +
      (supportCode ? `サポートコード: ${supportCode}\n` : '') +
      'お手数ですが、少し時間をおいてもう一度お試しください。\n' +
      '解決しない場合は、運営までお問い合わせください。',
  };
}

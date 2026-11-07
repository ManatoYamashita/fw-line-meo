// LINE Webhook のイベント正規化・重複排除ディスパッチャ（design.md「EventDispatcher」）。
// Requirement 1.1: events: []（接続確認 ping）は何もせず解決する（呼び出し側が 200 を返す）。
// Requirement 5.4: 同一 webhookEventId の再処理を防ぐ（LINE 再配信の isRedelivery も同一経路で救済）。
//
// 正規化対象は follow / message / postback。message のうち text 以外のサブタイプ
// （スタンプ・画像等）は Requirement 5.3（期待外入力への案内再送）の対象であるため、
// 黙殺せず `unsupported` として会話層へ渡す。source.userId・replyToken 欠落イベントや
// unfollow・join 等の未知イベント型は前方互換のため黙って無視する（拒否しない）。
//
// JSON パースに失敗した場合はここで握りつぶさず例外を伝播させる。
// app.ts 側のエラー境界（Requirement 7.5・タスク 4.1）が汎用の再試行案内 reply を担当する設計のため。

export type InboundEvent =
  | { kind: 'follow'; lineUserId: string; replyToken: string }
  | { kind: 'text'; lineUserId: string; replyToken: string; text: string }
  | { kind: 'postback'; lineUserId: string; replyToken: string; data: string }
  // Requirement 5.3: text 以外の message（スタンプ・画像等）。メッセージ内容自体は
  // 会話層で一切使用しないため保持しない（客・オーナーの送信内容を不必要に持ち回らない）。
  // 例外は一括発信（line-crosspost・Issue #494）が有効なときの画像だけで、そのときに限り本体を取得するための
  // message.id と、まとめて送られた画像の並び（imageSet）を `image` に載せる。本体（画像のバイト列）は持たない。
  // 一括発信が無効なら `image` は付かず、従来と同じく内容を一切持たない。
  | { kind: 'unsupported'; lineUserId: string; replyToken: string; image?: InboundImage };

/** 一括発信が有効なときだけ付く、画像メッセージの取得の手掛かり。 */
export interface InboundImage {
  messageId: string;
  /** line = LINE のサーバーにある（Content API で取得できる）。external = 送信者の指定した外部 URL。 */
  contentProvider: 'line' | 'external';
  /** まとめて送られたときの並び（index は 1 始まり）。単独なら null。 */
  imageSet: { id: string; index: number; total: number } | null;
  /** このメッセージの引用の手掛かり（最終確認で店主が送った写真を引用する）。無ければ null。 */
  quoteToken: string | null;
  /**
   * 店主が写真を送った時刻（イベントの timestamp・UNIX ミリ秒）。LINE は「イベントの順序は timestamp で判定する。
   * 届く順は異なりうる。再配信でも元の時刻を保つ」とする（references/webhook-events.md）。無ければ null。
   */
  sentAt: number | null;
}

export interface EventDispatcher {
  dispatch(rawWebhookBody: string): Promise<void>;
}

export interface EventDispatcherDeps {
  // webhookEventId を初回のみ記録する。true=今回が初回（処理続行）、false=既記録（スキップ）。
  // `ts/packages/db/src/webhook-events.ts` の recordWebhookEventOnce を pool 束縛した関数を注入する想定
  // （実配線はタスク 4.1）。
  recordWebhookEventOnce: (webhookEventId: string) => Promise<boolean>;
  // 一括発信（line-crosspost）が有効なときだけ true。画像の message.id を `unsupported.image` に載せる。
  // 省略・false のときは従来どおり（画像の内容を一切持ち回らない）。
  acceptImages?: boolean;
  // follow/message(text)/postback を委譲する先（ConversationHandlers、タスク 3.x/4.1 で実体を配線）。
  onEvent: (event: InboundEvent) => Promise<void>;
}

// LINE webhook の生イベント形状（必要フィールドのみ）。
// references/webhook-events.md 準拠。未知フィールドは無視してよいため他は型に含めない。
interface RawLineSource {
  type?: string;
  userId?: string;
}

interface RawLineMessage {
  type?: string;
  text?: string;
  id?: string;
  quoteToken?: string;
  contentProvider?: { type?: string };
  imageSet?: { id?: string; index?: number; total?: number };
}

interface RawLinePostback {
  data?: string;
}

interface RawLineEvent {
  type?: string;
  timestamp?: number;
  replyToken?: string;
  source?: RawLineSource;
  webhookEventId?: string;
  message?: RawLineMessage;
  postback?: RawLinePostback;
}

interface RawWebhookBody {
  destination?: string;
  events?: RawLineEvent[];
}

interface ParsedInboundEvent {
  webhookEventId: string;
  event: InboundEvent;
}

// 生イベントを InboundEvent に正規化する。冪等化キー（webhookEventId）も併せて返す。
// 必須フィールド（source.userId・replyToken・webhookEventId）欠落や未知/未対応の型は null。
const MESSAGE_ID_PATTERN = /^\d{1,32}$/;

function parseImage(message: RawLineMessage | undefined, timestamp: number | undefined): InboundImage | undefined {
  if (message?.type !== 'image' || typeof message.id !== 'string' || !MESSAGE_ID_PATTERN.test(message.id)) {
    return undefined;
  }
  const set = message.imageSet;
  const index = set?.index;
  const total = set?.total;
  const imageSet =
    set !== undefined &&
    typeof set.id === 'string' &&
    typeof index === 'number' &&
    typeof total === 'number' &&
    Number.isSafeInteger(index) &&
    Number.isSafeInteger(total) &&
    index >= 1 &&
    total >= index
      ? { id: set.id, index, total }
      : null;
  return {
    messageId: message.id,
    contentProvider: message.contentProvider?.type === 'external' ? 'external' : 'line',
    imageSet,
    quoteToken:
      typeof message.quoteToken === 'string' && message.quoteToken.length > 0 && message.quoteToken.length <= 512
        ? message.quoteToken
        : null,
    sentAt: typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null,
  };
}

function parseEvent(raw: RawLineEvent, acceptImages: boolean): ParsedInboundEvent | null {
  const webhookEventId = raw.webhookEventId;
  const lineUserId = raw.source?.userId;
  const replyToken = raw.replyToken;

  if (!webhookEventId || !lineUserId || !replyToken) {
    return null;
  }

  switch (raw.type) {
    case 'follow':
      return { webhookEventId, event: { kind: 'follow', lineUserId, replyToken } };

    case 'message': {
      if (raw.message?.type !== 'text') {
        // Requirement 5.3: スタンプ・画像等のテキスト以外の message は、黙殺せず
        // unsupported として会話層へ渡す（会話層が現在の段階の案内を再送する）。
        // replyToken 等の欠落は本関数冒頭のガードで既に除外済み（reply 不能な入力は無視）。
        const image = acceptImages ? parseImage(raw.message, raw.timestamp) : undefined;
        return {
          webhookEventId,
          event:
            image === undefined
              ? { kind: 'unsupported', lineUserId, replyToken }
              : { kind: 'unsupported', lineUserId, replyToken, image },
        };
      }
      const text = raw.message.text;
      if (typeof text !== 'string') {
        return null;
      }
      return { webhookEventId, event: { kind: 'text', lineUserId, replyToken, text } };
    }

    case 'postback': {
      const data = raw.postback?.data;
      if (typeof data !== 'string') {
        return null;
      }
      return { webhookEventId, event: { kind: 'postback', lineUserId, replyToken, data } };
    }

    default:
      return null;
  }
}

export function createEventDispatcher(deps: EventDispatcherDeps): EventDispatcher {
  return {
    async dispatch(rawWebhookBody: string): Promise<void> {
      const body = JSON.parse(rawWebhookBody) as RawWebhookBody;
      const events = body.events ?? [];

      for (const raw of events) {
        const parsed = parseEvent(raw, deps.acceptImages === true);
        if (!parsed) {
          continue;
        }

        const isFirstDelivery = await deps.recordWebhookEventOnce(parsed.webhookEventId);
        if (!isFirstDelivery) {
          continue;
        }

        await deps.onEvent(parsed.event);
      }
    },
  };
}

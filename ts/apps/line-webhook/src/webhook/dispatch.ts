// LINE Webhook のイベント正規化・重複排除ディスパッチャ（design.md「EventDispatcher」）。
// Requirement 1.1: events: []（接続確認 ping）は何もせず解決する（呼び出し側が 200 を返す）。
// Requirement 5.4: 同一 webhookEventId の再処理を防ぐ（LINE 再配信の isRedelivery も同一経路で救済）。
//
// 正規化対象は follow / message(text) / postback のみ。source.userId 欠落イベントや
// unfollow・join 等の未知イベント型は前方互換のため黙って無視する（拒否しない）。
//
// JSON パースに失敗した場合はここで握りつぶさず例外を伝播させる。
// app.ts 側のエラー境界（Requirement 7.5・タスク 4.1）が汎用の再試行案内 reply を担当する設計のため。

export type InboundEvent =
  | { kind: 'follow'; lineUserId: string; replyToken: string }
  | { kind: 'text'; lineUserId: string; replyToken: string; text: string }
  | { kind: 'postback'; lineUserId: string; replyToken: string; data: string };

export interface EventDispatcher {
  dispatch(rawWebhookBody: string): Promise<void>;
}

export interface EventDispatcherDeps {
  // webhookEventId を初回のみ記録する。true=今回が初回（処理続行）、false=既記録（スキップ）。
  // `ts/packages/db/src/webhook-events.ts` の recordWebhookEventOnce を pool 束縛した関数を注入する想定
  // （実配線はタスク 4.1）。
  recordWebhookEventOnce: (webhookEventId: string) => Promise<boolean>;
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
}

interface RawLinePostback {
  data?: string;
}

interface RawLineEvent {
  type?: string;
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
function parseEvent(raw: RawLineEvent): ParsedInboundEvent | null {
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
      const text = raw.message?.type === 'text' ? raw.message.text : undefined;
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
        const parsed = parseEvent(raw);
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

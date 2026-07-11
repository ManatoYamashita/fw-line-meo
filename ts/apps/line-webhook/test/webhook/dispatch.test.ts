import { describe, it, expect, vi } from 'vitest';
import { createEventDispatcher, type InboundEvent } from '../../src/webhook/dispatch.js';

// recordWebhookEventOnce のフェイク実装。
// 実 DB（INSERT ... ON CONFLICT DO NOTHING）と同じ契約（true=初回、false=既記録）を
// インメモリ Set で再現する。
function createFakeRecordWebhookEventOnce(): (webhookEventId: string) => Promise<boolean> {
  const seen = new Set<string>();
  return async (webhookEventId: string) => {
    if (seen.has(webhookEventId)) {
      return false;
    }
    seen.add(webhookEventId);
    return true;
  };
}

describe('createEventDispatcher', () => {
  it('events: [] （接続確認）は onEvent を呼ばずに解決する', async () => {
    const onEvent = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({
      recordWebhookEventOnce: createFakeRecordWebhookEventOnce(),
      onEvent,
    });

    await expect(
      dispatcher.dispatch(JSON.stringify({ destination: 'Uxxxx', events: [] })),
    ).resolves.toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('source.userId 欠落のイベントは無視される', async () => {
    const onEvent = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({
      recordWebhookEventOnce: createFakeRecordWebhookEventOnce(),
      onEvent,
    });

    const body = {
      destination: 'Uxxxx',
      events: [
        {
          type: 'follow',
          replyToken: 'reply-1',
          source: { type: 'group' },
          webhookEventId: 'evt-1',
        },
      ],
    };

    await dispatcher.dispatch(JSON.stringify(body));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('未知のイベント型（unfollow）は無視される', async () => {
    const onEvent = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({
      recordWebhookEventOnce: createFakeRecordWebhookEventOnce(),
      onEvent,
    });

    const body = {
      destination: 'Uxxxx',
      events: [
        {
          type: 'unfollow',
          source: { type: 'user', userId: 'U1' },
          webhookEventId: 'evt-2',
        },
      ],
    };

    await dispatcher.dispatch(JSON.stringify(body));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('text 以外の message サブタイプ（image）は unsupported として正規化され onEvent に渡される（Req 5.3）', async () => {
    const onEvent = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({
      recordWebhookEventOnce: createFakeRecordWebhookEventOnce(),
      onEvent,
    });

    const body = {
      destination: 'Uxxxx',
      events: [
        {
          type: 'message',
          replyToken: 'reply-3',
          source: { type: 'user', userId: 'U1' },
          webhookEventId: 'evt-3',
          message: { type: 'image', id: 'msg-1' },
        },
      ],
    };

    await dispatcher.dispatch(JSON.stringify(body));

    const expected: InboundEvent = {
      kind: 'unsupported',
      lineUserId: 'U1',
      replyToken: 'reply-3',
    };
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expected);
  });

  it('スタンプ（sticker）message も unsupported として正規化され onEvent に渡される（Req 5.3）', async () => {
    const onEvent = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({
      recordWebhookEventOnce: createFakeRecordWebhookEventOnce(),
      onEvent,
    });

    const body = {
      destination: 'Uxxxx',
      events: [
        {
          type: 'message',
          replyToken: 'reply-sticker',
          source: { type: 'user', userId: 'U1' },
          webhookEventId: 'evt-sticker',
          message: { type: 'sticker', id: 'msg-2', packageId: '446', stickerId: '1988' },
        },
      ],
    };

    await dispatcher.dispatch(JSON.stringify(body));

    const expected: InboundEvent = {
      kind: 'unsupported',
      lineUserId: 'U1',
      replyToken: 'reply-sticker',
    };
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expected);
  });

  it('replyToken を持たない非 text message は unsupported にせず無視される（reply 不能な入力へのガード維持）', async () => {
    const onEvent = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({
      recordWebhookEventOnce: createFakeRecordWebhookEventOnce(),
      onEvent,
    });

    const body = {
      destination: 'Uxxxx',
      events: [
        {
          type: 'message',
          source: { type: 'user', userId: 'U1' },
          webhookEventId: 'evt-no-reply-token',
          message: { type: 'image', id: 'msg-3' },
        },
      ],
    };

    await dispatcher.dispatch(JSON.stringify(body));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('unsupported イベントも同一 webhookEventId の重複配信は dedup でスキップされる（Req 5.4）', async () => {
    const onEvent = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({
      recordWebhookEventOnce: createFakeRecordWebhookEventOnce(),
      onEvent,
    });

    const body = {
      destination: 'Uxxxx',
      events: [
        {
          type: 'message',
          replyToken: 'reply-dup-sticker',
          source: { type: 'user', userId: 'U1' },
          webhookEventId: 'evt-dup-sticker',
          message: { type: 'sticker', id: 'msg-4', packageId: '446', stickerId: '1988' },
        },
      ],
    };

    await dispatcher.dispatch(JSON.stringify(body));
    await dispatcher.dispatch(JSON.stringify(body));

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('follow イベントは正規化されて onEvent に渡される', async () => {
    const onEvent = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({
      recordWebhookEventOnce: createFakeRecordWebhookEventOnce(),
      onEvent,
    });

    const body = {
      destination: 'Uxxxx',
      events: [
        {
          type: 'follow',
          replyToken: 'reply-follow',
          source: { type: 'user', userId: 'U1' },
          webhookEventId: 'evt-follow',
          follow: { isUnblocked: false },
        },
      ],
    };

    await dispatcher.dispatch(JSON.stringify(body));

    const expected: InboundEvent = {
      kind: 'follow',
      lineUserId: 'U1',
      replyToken: 'reply-follow',
    };
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expected);
  });

  it('message(text) イベントは正規化されて onEvent に渡される', async () => {
    const onEvent = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({
      recordWebhookEventOnce: createFakeRecordWebhookEventOnce(),
      onEvent,
    });

    const body = {
      destination: 'Uxxxx',
      events: [
        {
          type: 'message',
          replyToken: 'reply-text',
          source: { type: 'user', userId: 'U1' },
          webhookEventId: 'evt-text',
          message: { type: 'text', id: 'msg-2', text: 'こんにちは' },
        },
      ],
    };

    await dispatcher.dispatch(JSON.stringify(body));

    const expected: InboundEvent = {
      kind: 'text',
      lineUserId: 'U1',
      replyToken: 'reply-text',
      text: 'こんにちは',
    };
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expected);
  });

  it('postback イベントは正規化されて onEvent に渡される', async () => {
    const onEvent = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({
      recordWebhookEventOnce: createFakeRecordWebhookEventOnce(),
      onEvent,
    });

    const body = {
      destination: 'Uxxxx',
      events: [
        {
          type: 'postback',
          replyToken: 'reply-postback',
          source: { type: 'user', userId: 'U1' },
          webhookEventId: 'evt-postback',
          postback: { data: 'a=confirm' },
        },
      ],
    };

    await dispatcher.dispatch(JSON.stringify(body));

    const expected: InboundEvent = {
      kind: 'postback',
      lineUserId: 'U1',
      replyToken: 'reply-postback',
      data: 'a=confirm',
    };
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expected);
  });

  it('同一 webhookEventId が2回届いた場合、2回目は onEvent を呼ばずスキップする', async () => {
    const onEvent = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({
      recordWebhookEventOnce: createFakeRecordWebhookEventOnce(),
      onEvent,
    });

    const body = {
      destination: 'Uxxxx',
      events: [
        {
          type: 'follow',
          replyToken: 'reply-dup',
          source: { type: 'user', userId: 'U1' },
          webhookEventId: 'evt-dup',
        },
      ],
    };

    await dispatcher.dispatch(JSON.stringify(body));
    await dispatcher.dispatch(JSON.stringify(body));

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('複数イベントのうち一部が dedup で既記録の場合、他は処理される', async () => {
    const onEvent = vi.fn(async () => {});
    const recordWebhookEventOnce = createFakeRecordWebhookEventOnce();
    // evt-a を事前に「既記録」にしておく
    await recordWebhookEventOnce('evt-a');

    const dispatcher = createEventDispatcher({ recordWebhookEventOnce, onEvent });

    const body = {
      destination: 'Uxxxx',
      events: [
        {
          type: 'follow',
          replyToken: 'reply-a',
          source: { type: 'user', userId: 'U1' },
          webhookEventId: 'evt-a',
        },
        {
          type: 'follow',
          replyToken: 'reply-b',
          source: { type: 'user', userId: 'U2' },
          webhookEventId: 'evt-b',
        },
      ],
    };

    await dispatcher.dispatch(JSON.stringify(body));

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      kind: 'follow',
      lineUserId: 'U2',
      replyToken: 'reply-b',
    });
  });
});

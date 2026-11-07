import { describe, expect, it, vi } from 'vitest';
import { createEventDispatcher, type InboundEvent } from '../../src/webhook/dispatch.js';

function body(message: Record<string, unknown>, id = 'evt-image-1'): string {
  return JSON.stringify({
    destination: 'U0',
    events: [{ type: 'message', timestamp: 1_700_000_000_123, replyToken: 'r1', source: { type: 'user', userId: 'U1' }, webhookEventId: id, message }],
  });
}

describe('画像メッセージの正規化（line-crosspost）', () => {
  it('一括発信が OFF なら、従来どおり内容を持たない unsupported にする', async () => {
    const events: InboundEvent[] = [];
    const dispatcher = createEventDispatcher({ recordWebhookEventOnce: async () => true, onEvent: async (e) => void events.push(e) });
    await dispatcher.dispatch(body({ type: 'image', id: '123', contentProvider: { type: 'line' } }));
    expect(events).toEqual([{ kind: 'unsupported', lineUserId: 'U1', replyToken: 'r1' }]);
  });

  it('ON なら message.id と並びを image に載せる', async () => {
    const onEvent = vi.fn(async (_e: InboundEvent) => {});
    const dispatcher = createEventDispatcher({ recordWebhookEventOnce: async () => true, onEvent, acceptImages: true });
    await dispatcher.dispatch(
      body({ type: 'image', id: '456', quoteToken: 'q-456', contentProvider: { type: 'line' }, imageSet: { id: 'set1', index: 2, total: 3 } }),
    );
    expect(onEvent).toHaveBeenCalledWith({
      kind: 'unsupported',
      lineUserId: 'U1',
      replyToken: 'r1',
      image: { messageId: '456', contentProvider: 'line', imageSet: { id: 'set1', index: 2, total: 3 }, quoteToken: 'q-456', sentAt: 1_700_000_000_123 },
    });
  });

  it('ON でも画像以外・形の誤った ID は image を付けない。外部の画像は external にする', async () => {
    const events: InboundEvent[] = [];
    const dispatcher = createEventDispatcher({
      recordWebhookEventOnce: async () => true,
      onEvent: async (e) => void events.push(e),
      acceptImages: true,
    });
    await dispatcher.dispatch(body({ type: 'sticker', id: '1' }, 'e1'));
    await dispatcher.dispatch(body({ type: 'image', id: '../x' }, 'e2'));
    await dispatcher.dispatch(body({ type: 'image', id: '789', contentProvider: { type: 'external' } }, 'e3'));
    expect(events[0]).toEqual({ kind: 'unsupported', lineUserId: 'U1', replyToken: 'r1' });
    expect(events[1]).toEqual({ kind: 'unsupported', lineUserId: 'U1', replyToken: 'r1' });
    expect(events[2]).toMatchObject({ image: { messageId: '789', contentProvider: 'external', imageSet: null, quoteToken: null, sentAt: 1_700_000_000_123 } });
  });
});

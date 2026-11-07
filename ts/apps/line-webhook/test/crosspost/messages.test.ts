import { describe, expect, it } from 'vitest';
import type { CrosspostDeliveryContext, CrosspostDeliveryRow, CrosspostDraftRow } from '@fwlm/db';
import {
  availableChoices,
  buildConfirmMessage,
  buildResultMessage,
  buildReviewMessage,
  buildStartMessage,
} from '../../src/crosspost/messages.js';
import type { AvailabilityMap } from '../../src/crosspost/publisher.js';
import type { LineMessage } from '../../src/line/client.js';

const DRAFT = '11111111-2222-4333-8444-555555555555';
const STORE = '22222222-2222-4333-8444-555555555555';
const NOW = new Date('2026-11-07T00:00:00Z');

function draft(overrides: Partial<CrosspostDraftRow> = {}): CrosspostDraftRow {
  return {
    id: DRAFT,
    owner_id: '33333333-2222-4333-8444-555555555555',
    store_id: STORE,
    status: 'reviewing',
    input_mode: 'none',
    input_destination: null,
    revision: 3,
    material_text: '新作の抹茶パフェ',
    instagram_text: 'IGの文',
    google_text: 'Googleの文',
    approved_revision: null,
    approved_at: null,
    result_notified_at: null,
    expires_at: NOW,
    purge_after: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function delivery(overrides: Partial<CrosspostDeliveryRow>): CrosspostDeliveryContext {
  return {
    ownerId: 'o',
    storeId: STORE,
    storeName: '森のカフェ',
    media: null,
    delivery: {
      id: '44444444-2222-4333-8444-555555555555',
      draft_id: DRAFT,
      destination: 'google',
      status: 'succeeded',
      body_text: 'Googleの文',
      with_media: false,
      media_id: null,
      attempt_count: 1,
      retryable: false,
      failure_reason: null,
      unknown_reason: null,
      checkpoint: null,
      external_id: null,
      external_url: null,
      last_attempt_at: NOW,
      finished_at: NOW,
      created_at: NOW,
      updated_at: NOW,
      ...overrides,
    },
  };
}

const BOTH: AvailabilityMap = { instagram: { kind: 'available' }, google: { kind: 'available' } };

/** メッセージ内のすべての action（ボタン・クイックリプライ）を集める。 */
function actions(message: LineMessage): Array<Record<string, string>> {
  const found: Array<Record<string, string>> = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.type === 'string' && typeof record.label === 'string' && ['postback', 'clipboard', 'uri'].includes(record.type)) {
        found.push(record as Record<string, string>);
      }
      Object.values(record).forEach(walk);
    }
  };
  walk(message);
  return found;
}

describe('crosspost messages の LINE の制約', () => {
  const messages: Array<[string, LineMessage]> = [
    ['start', buildStartMessage({ draftId: DRAFT, storeName: '森のカフェ', availability: BOTH })],
    ['review', buildReviewMessage({ draft: draft(), storeName: '森のカフェ', availability: BOTH, hasPhoto: true, googleConnectAvailable: true })],
    ...buildConfirmMessage({ draft: draft(), storeName: '森のカフェ', choice: 'both', photo: { width: 1440, height: 960, quoteToken: 'qt' } }).map(
      (m, i): [string, LineMessage] => [`confirm-${i}`, m],
    ),
  ];

  it.each(messages)('%s: ボタンのラベルは 40 字・クイックリプライは 20 字・postback は 300 字以内', (_name, message) => {
    for (const action of actions(message)) {
      expect([...action.label!].length).toBeLessThanOrEqual(40);
      if (action.type === 'postback') expect(action.data!.length).toBeLessThanOrEqual(300);
    }
    if (message.type === 'text' && message.quickReply) {
      for (const item of message.quickReply.items) expect([...item.action.label].length).toBeLessThanOrEqual(20);
    }
    if (message.type === 'flex') expect(message.altText.length).toBeLessThanOrEqual(400);
  });

  it('文が 1000 字を超えるとコピーのボタンを出さない（clipboardText の上限）', () => {
    const long = buildReviewMessage({
      draft: draft({ google_text: 'あ'.repeat(1001) }),
      storeName: '森のカフェ',
      availability: BOTH,
      hasPhoto: false,
      googleConnectAvailable: false,
    });
    const clipboards = actions(long).filter((a) => a.type === 'clipboard');
    expect(clipboards).toHaveLength(1);
    expect(clipboards[0]!.clipboardText).toBe('IGの文');
  });

  it('使える投稿先の組み合わせだけを選ばせる', () => {
    expect(availableChoices(draft(), BOTH)).toEqual(['both', 'instagram', 'google']);
    expect(availableChoices(draft(), { instagram: { kind: 'not_ready' }, google: { kind: 'available' } })).toEqual(['google']);
    expect(availableChoices(draft({ google_text: null }), BOTH)).toEqual(['instagram']);
  });

  it('最終確認だけが承認の postback（x_ok）を持ち、写り込みの注意を出す', () => {
    const confirm = buildConfirmMessage({
      draft: draft(),
      storeName: '森のカフェ',
      choice: 'google',
      photo: { width: 960, height: 1440, quoteToken: 'qt-1' },
    });
    expect(confirm[0]).toMatchObject({ type: 'text', quoteToken: 'qt-1' });
    expect(JSON.stringify(confirm[0])).toContain('縦長');
    expect(confirm.flatMap(actions).some((a) => a.data?.startsWith('a=x_ok'))).toBe(true);
    expect(JSON.stringify(confirm)).toContain('写っていないか');
    // 引用できない写真は、向きを示して送り直しを促す（引用の手掛かりを持たない）
    const unquoted = buildConfirmMessage({ draft: draft(), storeName: 's', choice: 'google', photo: { width: 100, height: 100, quoteToken: null } });
    expect(unquoted[0]).not.toHaveProperty('quoteToken');
    expect(JSON.stringify(unquoted[0])).toContain('送り直して');
    // 写真なしは引用のテキストを出さない
    expect(buildConfirmMessage({ draft: draft(), storeName: 's', choice: 'google', photo: null })).toHaveLength(1);
    const review = buildReviewMessage({ draft: draft(), storeName: '森のカフェ', availability: BOTH, hasPhoto: true, googleConnectAvailable: true });
    expect(actions(review).some((a) => a.data?.startsWith('a=x_ok'))).toBe(false);
  });
});

describe('buildResultMessage', () => {
  it('成功・失敗・結果不明を区別し、結果不明には店主の確認のボタンを出す', () => {
    const message = buildResultMessage({
      storeName: '森のカフェ',
      deliveries: [
        delivery({ destination: 'instagram', status: 'succeeded' }),
        delivery({ destination: 'google', status: 'unknown', unknown_reason: 'network' }),
      ],
    });
    const text = JSON.stringify(message);
    expect(text).toContain('Instagram: 投稿しました');
    expect(text).toContain('確認できませんでした');
    expect(actions(message).map((a) => a.label)).toEqual(
      expect.arrayContaining(['Googleに投稿されていた', 'Googleに投稿されていなかった']),
    );
    expect(actions(message).some((a) => a.data?.startsWith('a=x_retry'))).toBe(false);
  });

  it('Google の連携の期限切れは、連携の入口が使えるときだけ再連携のボタンを出す', () => {
    const failed = delivery({ status: 'failed', failure_reason: 'token_invalid', retryable: false });
    const withConnect = buildResultMessage({ storeName: '森のカフェ', deliveries: [failed], googleConnectAvailable: true });
    expect(actions(withConnect).some((a) => a.data === `a=g_relink&s=${STORE}`)).toBe(true);
    const without = buildResultMessage({ storeName: '森のカフェ', deliveries: [failed] });
    expect(actions(without).some((a) => a.data?.startsWith('a=g_'))).toBe(false);
  });

  it('再試行できる失敗には再試行のボタンを出し、上限に達したら出さない', () => {
    const retryable = delivery({ status: 'failed', failure_reason: 'rate_limited', retryable: true, attempt_count: 1 });
    expect(actions(buildResultMessage({ storeName: 's', deliveries: [retryable] })).some((a) => a.data?.startsWith('a=x_retry'))).toBe(true);
    const exhausted = delivery({ status: 'failed', failure_reason: 'rate_limited', retryable: true, attempt_count: 3 });
    expect(actions(buildResultMessage({ storeName: 's', deliveries: [exhausted] })).some((a) => a.data?.startsWith('a=x_retry'))).toBe(false);
  });
});

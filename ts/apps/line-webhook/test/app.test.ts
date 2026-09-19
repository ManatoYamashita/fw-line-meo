import { describe, it, expect, vi } from 'vitest';
import { createApp, type AppDeps, type AppLogger } from '../src/app.js';
import type { Sink } from '@fwlm/observability';
import type { SignatureVerifier } from '../src/webhook/signature.js';
import type { ConversationHandlers } from '../src/onboarding/conversation.js';
import type { LineMessage, LineMessenger } from '../src/line/client.js';
import { buildInternalErrorRetryMessage } from '../src/line/messages.js';
import { StoreScopedReportError } from '../src/report/errors.js';

// createApp(deps) の配線・エラー境界（タスク 4.1）のテスト。
// 実依存（pool/fetch/LINE client 等）は一切使わず、すべてフェイク/スパイで検証する
// （実依存の配線・アプリレベルフローテストはタスク 4.2 の責務）。

function fakeSignatureVerifier(result: boolean): SignatureVerifier {
  return { verify: vi.fn(() => result) };
}

function fakeConversationHandlers(
  impl: ConversationHandlers['handleEvent'] = async () => {},
): ConversationHandlers {
  return { handleEvent: vi.fn(impl) };
}

function fakeMessenger(impl?: LineMessenger['reply']): Pick<LineMessenger, 'reply'> {
  return { reply: vi.fn(impl ?? (async () => {})) };
}

function fakeLogger(): AppLogger {
  return { error: vi.fn() };
}

function fakeStructuredLog(): Sink {
  return vi.fn();
}

function fakeRecordWebhookEventOnce(): (webhookEventId: string) => Promise<boolean> {
  return vi.fn(async () => true);
}

function baseDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    signatureVerifier: fakeSignatureVerifier(true),
    recordWebhookEventOnce: fakeRecordWebhookEventOnce(),
    conversationHandlers: fakeConversationHandlers(),
    messenger: fakeMessenger(),
    logger: fakeLogger(),
    structuredLog: fakeStructuredLog(),
    ...overrides,
  };
}

function followEventBody(overrides: { replyToken?: string; webhookEventId?: string } = {}) {
  return JSON.stringify({
    destination: 'Uxxxx',
    events: [
      {
        type: 'follow',
        replyToken: overrides.replyToken ?? 'reply-1',
        source: { type: 'user', userId: 'U1' },
        webhookEventId: overrides.webhookEventId ?? 'evt-1',
      },
    ],
  });
}

// 1リクエストの events: [] に複数イベントを積んだボディ（Finding 3 回帰テスト用）。
function twoEventsBody(
  overrides: {
    event1ReplyToken?: string;
    event1WebhookEventId?: string;
    event2ReplyToken?: string;
    event2WebhookEventId?: string;
  } = {},
) {
  return JSON.stringify({
    destination: 'Uxxxx',
    events: [
      {
        type: 'follow',
        replyToken: overrides.event1ReplyToken ?? 'reply-evt1',
        source: { type: 'user', userId: 'U1' },
        webhookEventId: overrides.event1WebhookEventId ?? 'evt-1',
      },
      {
        type: 'follow',
        replyToken: overrides.event2ReplyToken ?? 'reply-evt2',
        source: { type: 'user', userId: 'U2' },
        webhookEventId: overrides.event2WebhookEventId ?? 'evt-2',
      },
    ],
  });
}

describe('line-webhook app', () => {
  it('GET /health は 200 で status ok を返す', async () => {
    const res = await createApp(baseDeps()).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  describe('POST /webhook', () => {
    it('署名 OK・dispatch 成功時は 200 を返し、会話ハンドラへイベントが渡る', async () => {
      const conversationHandlers = fakeConversationHandlers();
      const app = createApp(baseDeps({ conversationHandlers }));

      const res = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': 'valid-signature' },
        body: followEventBody(),
      });

      expect(res.status).toBe(200);
      expect(conversationHandlers.handleEvent).toHaveBeenCalledTimes(1);
      expect(conversationHandlers.handleEvent).toHaveBeenCalledWith({
        kind: 'follow',
        lineUserId: 'U1',
        replyToken: 'reply-1',
      });
    });

    it('テキスト以外の message（スタンプ）も黙殺されず、unsupported として会話ハンドラへ渡り 200 を返す（Req 5.3）', async () => {
      const conversationHandlers = fakeConversationHandlers();
      const app = createApp(baseDeps({ conversationHandlers }));

      const res = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': 'valid-signature' },
        body: JSON.stringify({
          destination: 'Uxxxx',
          events: [
            {
              type: 'message',
              replyToken: 'reply-sticker',
              source: { type: 'user', userId: 'U1' },
              webhookEventId: 'evt-sticker',
              message: { type: 'sticker', id: 'msg-1', packageId: '446', stickerId: '1988' },
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      expect(conversationHandlers.handleEvent).toHaveBeenCalledTimes(1);
      expect(conversationHandlers.handleEvent).toHaveBeenCalledWith({
        kind: 'unsupported',
        lineUserId: 'U1',
        replyToken: 'reply-sticker',
      });
    });

    it('署名不正は 401 を返し、会話ハンドラ（dispatcher）は一切呼ばれない', async () => {
      const conversationHandlers = fakeConversationHandlers();
      const app = createApp(
        baseDeps({ signatureVerifier: fakeSignatureVerifier(false), conversationHandlers }),
      );

      const res = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': 'invalid-signature' },
        body: followEventBody(),
      });

      expect(res.status).toBe(401);
      expect(conversationHandlers.handleEvent).not.toHaveBeenCalled();
    });

    it('署名ヘッダ欠落も 401 を返し、会話ハンドラは呼ばれない', async () => {
      const conversationHandlers = fakeConversationHandlers();
      const app = createApp(
        baseDeps({ signatureVerifier: fakeSignatureVerifier(false), conversationHandlers }),
      );

      const res = await app.request('/webhook', {
        method: 'POST',
        body: followEventBody(),
      });

      expect(res.status).toBe(401);
      expect(conversationHandlers.handleEvent).not.toHaveBeenCalled();
    });

    // Issue #230: 401 は Cloud Run の 5xx 率に現れないため、この 1 行が出ないと
    // 署名検証が全件失敗していても外からは無音になる。ログベース指標
    // webhook_signature_failures が数える唯一の入力なので、事象名を固定して検証する。
    it('署名不一致のとき固定イベントを構造化ログへ 1 件出し、reason=mismatch を載せる', async () => {
      const structuredLog = fakeStructuredLog();
      const app = createApp(
        baseDeps({ signatureVerifier: fakeSignatureVerifier(false), structuredLog }),
      );

      const res = await app.request('/webhook', {
        method: 'POST',
        headers: {
          'x-line-signature': 'invalid-signature',
          'x-line-request-id': 'req-sig-1',
        },
        body: followEventBody(),
      });

      expect(res.status).toBe(401);
      expect(structuredLog).toHaveBeenCalledTimes(1);
      expect(structuredLog).toHaveBeenCalledWith('warn', 'webhook_signature_verification_failed', {
        reason: 'mismatch',
        lineRequestId: 'req-sig-1',
      });
    });

    it('署名ヘッダ欠落のときは reason=missing_header で区別される', async () => {
      const structuredLog = fakeStructuredLog();
      const app = createApp(
        baseDeps({ signatureVerifier: fakeSignatureVerifier(false), structuredLog }),
      );

      const res = await app.request('/webhook', { method: 'POST', body: followEventBody() });

      expect(res.status).toBe(401);
      expect(structuredLog).toHaveBeenCalledWith('warn', 'webhook_signature_verification_failed', {
        reason: 'missing_header',
      });
    });

    // 否定側。これが無いと「常に出す」実装でも上の 2 件が緑になり、指標が
    // 正常なリクエストまで数えていることに気づけない。
    it('署名が通ったリクエストでは署名失敗イベントを出さない', async () => {
      const structuredLog = fakeStructuredLog();
      const app = createApp(baseDeps({ structuredLog }));

      const res = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': 'valid-signature' },
        body: followEventBody(),
      });

      expect(res.status).toBe(200);
      expect(structuredLog).not.toHaveBeenCalled();
    });

    it(
      '署名 OK・内部例外（会話ハンドラが throw）時は 200 を返し、' +
        '直近処理中イベントの replyToken へ汎用の再試行案内 reply を試み、structured log に記録する',
      async () => {
        const conversationHandlers = fakeConversationHandlers(async () => {
          throw new Error('boom: unexpected downstream failure');
        });
        const messenger = fakeMessenger();
        const logger = fakeLogger();
        const app = createApp(baseDeps({ conversationHandlers, messenger, logger }));

        const res = await app.request('/webhook', {
          method: 'POST',
          headers: { 'x-line-signature': 'valid-signature' },
          body: followEventBody({ replyToken: 'reply-fail' }),
        });

        // Decision: dispatch() は失敗イベントを recordWebhookEventOnce で「処理試行済み」に
        // 記録済みのため、5xx で再配信を誘発しても dedup によりそのイベントは再処理されず
        // 実効的な回復効果がない（research.md Decision 1）。よって 200 を返す。
        expect(res.status).toBe(200);

        expect(messenger.reply).toHaveBeenCalledTimes(1);
        expect(messenger.reply).toHaveBeenCalledWith('reply-fail', [buildInternalErrorRetryMessage()]);

        // 例外の本文は記録しない（要件 2.5）。種別で原因を切り分ける。
        expect(logger.error).toHaveBeenCalledWith(
          'line-webhook.dispatch_failed',
          expect.objectContaining({ errorKind: 'Error' }),
        );
      },
    );

    it('内部例外がイベントループに入る前（不正 JSON）に起きた場合は reply を試みず 200 を返す', async () => {
      const conversationHandlers = fakeConversationHandlers();
      const messenger = fakeMessenger();
      const logger = fakeLogger();
      const app = createApp(baseDeps({ conversationHandlers, messenger, logger }));

      const res = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': 'valid-signature' },
        body: '{not valid json',
      });

      expect(res.status).toBe(200);
      expect(conversationHandlers.handleEvent).not.toHaveBeenCalled();
      expect(messenger.reply).not.toHaveBeenCalled();
      // 返信を試みた失敗とは別の事象名で出る（運用者が案内の有無を判定できるように）。
      expect(logger.error).toHaveBeenCalledWith(
        'line-webhook.dispatch_failed_before_reply_token',
        expect.any(Object),
      );
    });

    it('再試行案内 reply 自体が失敗しても 200 を返し、失敗を structured log に記録する', async () => {
      const conversationHandlers = fakeConversationHandlers(async () => {
        throw new Error('boom');
      });
      const messenger = fakeMessenger(async () => {
        throw new Error('LINE reply API unavailable');
      });
      const logger = fakeLogger();
      const app = createApp(baseDeps({ conversationHandlers, messenger, logger }));

      const res = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': 'valid-signature' },
        body: followEventBody({ replyToken: 'reply-fail-2' }),
      });

      expect(res.status).toBe(200);
      expect(messenger.reply).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        'line-webhook.retry_reply_failed',
        expect.objectContaining({ errorKind: 'Error' }),
      );
    });

    it(
      '並行 POST /webhook: 遅く失敗するリクエストの再試行案内は、その間に完了する別リクエストの' +
        '成功に巻き込まれず、自分自身の replyToken で送信される（リクエスト間の状態共有が無いことの回帰テスト）',
      async () => {
        // 遅いリクエスト（slow）の会話ハンドラは、速いリクエスト（fast）の処理完了を
        // 明示的に待ってから失敗する。onEvent はイベントごとに自身の replyToken を
        // クロージャで直接使い、リクエスト間で共有する状態を持たないため、この実行順序でも
        // fast の成功が slow の再試行案内を握りつぶすことは構造的に起こり得ないことを確認する。
        let resolveFastDone!: () => void;
        const fastDone = new Promise<void>((resolve) => {
          resolveFastDone = resolve;
        });

        const conversationHandlers: ConversationHandlers = {
          handleEvent: vi.fn(async (event) => {
            if (event.replyToken === 'reply-slow-fail') {
              await fastDone;
              throw new Error('boom: slow request failure after fast request cleared its own state');
            }
            // fast: 即座に成功し、自身の（本来は分離されているべき）追跡状態をクリアする。
            resolveFastDone();
          }),
        };
        const messenger = fakeMessenger();
        const logger = fakeLogger();
        const app = createApp(baseDeps({ conversationHandlers, messenger, logger }));

        const slowRequest = app.request('/webhook', {
          method: 'POST',
          headers: { 'x-line-signature': 'valid-signature' },
          body: followEventBody({ replyToken: 'reply-slow-fail', webhookEventId: 'evt-slow' }),
        });
        const fastRequest = app.request('/webhook', {
          method: 'POST',
          headers: { 'x-line-signature': 'valid-signature' },
          body: followEventBody({ replyToken: 'reply-fast-ok', webhookEventId: 'evt-fast' }),
        });

        const [slowRes, fastRes] = await Promise.all([slowRequest, fastRequest]);

        expect(fastRes.status).toBe(200);
        expect(slowRes.status).toBe(200);

        // fast の成功と slow の失敗は、それぞれの onEvent 呼び出しの中で完結しており
        // 共有状態を経由しないため、slow 自身の replyToken での再試行案内が確実に送られる。
        expect(messenger.reply).toHaveBeenCalledTimes(1);
        expect(messenger.reply).toHaveBeenCalledWith('reply-slow-fail', [
          buildInternalErrorRetryMessage(),
        ]);
      },
    );

    it(
      '1リクエスト内の複数イベント: 先行イベントの成功後に後続イベントが失敗しても、' +
        '取り違えられず後続イベント自身の replyToken で再試行案内が送られる',
      async () => {
        const conversationHandlers: ConversationHandlers = {
          handleEvent: vi.fn(async (event) => {
            if (event.replyToken === 'reply-evt2') {
              throw new Error('boom: second event handler failure');
            }
            // event1 は正常終了。
          }),
        };
        const messenger = fakeMessenger();
        const logger = fakeLogger();
        const app = createApp(baseDeps({ conversationHandlers, messenger, logger }));

        const res = await app.request('/webhook', {
          method: 'POST',
          headers: { 'x-line-signature': 'valid-signature' },
          body: twoEventsBody(),
        });

        expect(res.status).toBe(200);
        expect(conversationHandlers.handleEvent).toHaveBeenCalledTimes(2);
        expect(messenger.reply).toHaveBeenCalledTimes(1);
        expect(messenger.reply).toHaveBeenCalledWith('reply-evt2', [buildInternalErrorRetryMessage()]);
      },
    );

    it(
      '1リクエスト内の複数イベント: 途中（2番目）のイベントが失敗しても、後続（3番目）の' +
        'イベントは処理が継続され黙って失われない（PR #15 レビュー是正の回帰テスト）',
      async () => {
        const conversationHandlers: ConversationHandlers = {
          handleEvent: vi.fn(async (event) => {
            if (event.replyToken === 'reply-evt2') {
              throw new Error('boom: second event handler failure');
            }
            // event1・event3 は正常終了。
          }),
        };
        const messenger = fakeMessenger();
        const logger = fakeLogger();
        const app = createApp(baseDeps({ conversationHandlers, messenger, logger }));

        const body = JSON.stringify({
          destination: 'Uxxxx',
          events: [
            {
              type: 'follow',
              replyToken: 'reply-evt1',
              source: { type: 'user', userId: 'U1' },
              webhookEventId: 'evt-1',
            },
            {
              type: 'follow',
              replyToken: 'reply-evt2',
              source: { type: 'user', userId: 'U2' },
              webhookEventId: 'evt-2',
            },
            {
              type: 'follow',
              replyToken: 'reply-evt3',
              source: { type: 'user', userId: 'U3' },
              webhookEventId: 'evt-3',
            },
          ],
        });

        const res = await app.request('/webhook', {
          method: 'POST',
          headers: { 'x-line-signature': 'valid-signature' },
          body,
        });

        expect(res.status).toBe(200);
        // 3件とも処理される（2番目の失敗で後続が打ち切られない）。
        expect(conversationHandlers.handleEvent).toHaveBeenCalledTimes(3);
        expect(conversationHandlers.handleEvent).toHaveBeenCalledWith(
          expect.objectContaining({ replyToken: 'reply-evt3' }),
        );
        expect(messenger.reply).toHaveBeenCalledTimes(1);
        expect(messenger.reply).toHaveBeenCalledWith('reply-evt2', [buildInternalErrorRetryMessage()]);
      },
    );

    it('内部例外発生時、structured log に X-Line-Request-Id ヘッダの値が併記される（design.md「Monitoring」）', async () => {
      const conversationHandlers = fakeConversationHandlers(async () => {
        throw new Error('boom');
      });
      const logger = fakeLogger();
      const app = createApp(baseDeps({ conversationHandlers, logger }));

      await app.request('/webhook', {
        method: 'POST',
        headers: {
          'x-line-signature': 'valid-signature',
          'x-line-request-id': 'req-abc-123',
        },
        body: followEventBody({ replyToken: 'reply-req-id' }),
      });

      // 項目名は正典が定める lineRequestId（相関識別子と紛らわしいため改名した）。
      expect(logger.error).toHaveBeenCalledWith(
        'line-webhook.dispatch_failed',
        expect.objectContaining({ lineRequestId: 'req-abc-123' }),
      );
    });

    it('同一 webhookEventId の重複配信は dispatcher の冪等化により会話ハンドラが1回のみ呼ばれる', async () => {
      const conversationHandlers = fakeConversationHandlers();
      const seen = new Set<string>();
      const recordWebhookEventOnce = vi.fn(async (id: string) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      const app = createApp(baseDeps({ conversationHandlers, recordWebhookEventOnce }));

      const body = followEventBody({ webhookEventId: 'evt-dup' });
      await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': 'valid-signature' },
        body,
      });
      const res2 = await app.request('/webhook', {
        method: 'POST',
        headers: { 'x-line-signature': 'valid-signature' },
        body,
      });

      expect(res2.status).toBe(200);
      expect(conversationHandlers.handleEvent).toHaveBeenCalledTimes(1);
    });
  });
});

// line-on-demand-report tasks 3.10（Requirements 7.4・7.5）: レポートの店舗を決めた後の失敗（StoreScopedReportError）には、
// 店舗名を添えた再試行案内をちょうど 1 回返す。店舗を決める前の失敗は汎用の再試行案内のまま。
// 案内に出してよいのは店舗名とサポートコードだけで、内部の詳細（元の例外の種別・本文）を出さない。
describe('エラー境界: 店舗名つきの再試行案内（line-on-demand-report Requirements 7.4・7.5）', () => {
  const STORE_NAME = '試験食堂 駅前店';
  // 元の例外の本文。案内にも記録にも現れてはならない。
  const INTERNAL_DETAIL = 'relation "daily_summaries" does not exist (10.0.0.1:5432)';
  const TRACE_ID = '0123456789abcdef0123456789abcdef';
  const SUPPORT_CODE = '01234567';

  function storeScopedFailure(cause: unknown = new TypeError(INTERNAL_DETAIL)): ConversationHandlers {
    return fakeConversationHandlers(async () => {
      throw new StoreScopedReportError(STORE_NAME, { cause });
    });
  }

  function textsOf(messages: readonly LineMessage[]): string[] {
    return messages.map((message) => (message.type === 'text' ? message.text : JSON.stringify(message)));
  }

  async function post(app: ReturnType<typeof createApp>, replyToken: string, headers: Record<string, string> = {}) {
    return app.request('/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': 'valid-signature', ...headers },
      body: followEventBody({ replyToken }),
    });
  }

  it('店舗名を添えた再試行案内をちょうど 1 回返し、汎用の再試行案内は返さない', async () => {
    const messenger = fakeMessenger();
    const app = createApp(baseDeps({ conversationHandlers: storeScopedFailure(), messenger }));

    const res = await post(app, 'reply-store-scoped');

    expect(res.status).toBe(200);
    expect(messenger.reply).toHaveBeenCalledTimes(1);
    expect(messenger.reply).toHaveBeenCalledWith('reply-store-scoped', [
      buildInternalErrorRetryMessage(undefined, STORE_NAME),
    ]);
    const [, messages] = vi.mocked(messenger.reply).mock.calls[0] ?? [];
    expect(messages).not.toEqual([buildInternalErrorRetryMessage()]);
    expect(textsOf(messages ?? []).join('\n')).toContain(`「${STORE_NAME}」`);
  });

  it('案内に出すのは店舗名とサポートコードだけで、内部の詳細を出さない', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    try {
      const messenger = fakeMessenger();
      const app = createApp(baseDeps({ conversationHandlers: storeScopedFailure(), messenger }));

      await post(app, 'reply-store-scoped-code', { 'x-cloud-trace-context': `${TRACE_ID}/1;o=1` });

      expect(messenger.reply).toHaveBeenCalledTimes(1);
      expect(messenger.reply).toHaveBeenCalledWith('reply-store-scoped-code', [
        buildInternalErrorRetryMessage(SUPPORT_CODE, STORE_NAME),
      ]);
      const [, messages] = vi.mocked(messenger.reply).mock.calls[0] ?? [];
      const text = textsOf(messages ?? []).join('\n');
      expect(text).toContain(`「${STORE_NAME}」`);
      expect(text).toContain(SUPPORT_CODE);
      for (const leaked of [INTERNAL_DETAIL, 'TypeError', 'StoreScopedReportError', new StoreScopedReportError(STORE_NAME).message]) {
        expect(text, leaked).not.toContain(leaked);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('記録は既存の dispatch_failed に元の例外の種別だけを載せ、店舗名と本文を載せない', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    try {
      const structuredLog = fakeStructuredLog();
      const app = createApp(baseDeps({ conversationHandlers: storeScopedFailure(), structuredLog }));

      await post(app, 'reply-store-scoped-log', { 'x-cloud-trace-context': `${TRACE_ID}/1;o=1` });

      expect(structuredLog).toHaveBeenCalledTimes(1);
      expect(structuredLog).toHaveBeenCalledWith('error', 'line-webhook.dispatch_failed', {
        errorKind: 'TypeError',
        correlationId: `projects/test-project/traces/${TRACE_ID}`,
      });
      const recorded = JSON.stringify(vi.mocked(structuredLog).mock.calls);
      expect(recorded).not.toContain(STORE_NAME);
      expect(recorded).not.toContain(INTERNAL_DETAIL);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('元の例外が無ければ、記録する種別は StoreScopedReportError のまま', async () => {
    const logger = fakeLogger();
    const app = createApp(
      baseDeps({
        conversationHandlers: fakeConversationHandlers(async () => {
          throw new StoreScopedReportError(STORE_NAME);
        }),
        logger,
      }),
    );

    await post(app, 'reply-store-scoped-no-cause');

    expect(logger.error).toHaveBeenCalledWith('line-webhook.dispatch_failed', { errorKind: 'StoreScopedReportError' });
  });

  it('店舗を決める前の例外（店舗名の無い例外）には、汎用の再試行案内をちょうど 1 回返す', async () => {
    const messenger = fakeMessenger();
    const app = createApp(
      baseDeps({
        conversationHandlers: fakeConversationHandlers(async () => {
          throw new Error(`failed for ${STORE_NAME}`);
        }),
        messenger,
      }),
    );

    await post(app, 'reply-before-resolution');

    expect(messenger.reply).toHaveBeenCalledTimes(1);
    expect(messenger.reply).toHaveBeenCalledWith('reply-before-resolution', [buildInternalErrorRetryMessage()]);
  });

  it('店舗名つきの再試行案内の Reply が失敗しても、試みるのは 1 回だけで、失敗を記録する', async () => {
    const messenger = fakeMessenger(async () => {
      throw new Error('LINE reply API unavailable');
    });
    const logger = fakeLogger();
    const app = createApp(baseDeps({ conversationHandlers: storeScopedFailure(), messenger, logger }));

    const res = await post(app, 'reply-store-scoped-reply-fails');

    expect(res.status).toBe(200);
    expect(messenger.reply).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('line-webhook.retry_reply_failed', { errorKind: 'Error' });
  });
});

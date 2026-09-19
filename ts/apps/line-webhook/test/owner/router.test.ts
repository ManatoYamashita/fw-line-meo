// 店舗特定済みオーナーの振り分け口の試験（design.md「StoreIdentifiedOwnerRouter」「店舗特定済みオーナーの振り分け」・
// Requirements 2.3, 2.5, 2.6, 2.8, 2.9）。
// - レポートの postback はレポートへ渡し、それ以外（postback・テキスト・スタンプなど・友だち追加）はステータス案内を返すこと。
//   会話の段階を問わず、オンボーディングの案内を返さないこと
// - Reply の後、段階が completed でない・友だち追加・再開の postback の 3 つの契機でだけ完了後メニューを張ること
// - 段階が completed でなかったときは、張れた場合に限り completed に揃えること
// - 成否を既存の事象と監査記録に残し、記録に店舗 ID と LINE ユーザー ID を載せないこと
// - オンボーディングの復号とレポートの復号が、互いの data を受理しないこと
//
// セッション・Reply・リンク・レポート・記録は偽物に差し替える。店舗 ID と LINE ユーザー ID は試験用の架空の値である。
import { describe, expect, it, vi } from 'vitest';
import type { AuditLogInput, OnboardingSessionRow, OwnerRow, Queryable, SessionPatch } from '@fwlm/db';
import { decodeReportPostback, encodeReportPostback, type ReportKind, type ReportRequest } from '@fwlm/line-report';
import type { LogFields } from '@fwlm/observability';
import type { LineMessage, LineMessenger } from '../../src/line/client.js';
import {
  buildGreetingMessage,
  buildStatusGuidanceMessage,
  buildStoreNameInputGuidanceMessage,
} from '../../src/line/messages.js';
import type { SessionsAccessor } from '../../src/onboarding/conversation.js';
import { decodePostback, encodePostback, type PostbackAction } from '../../src/onboarding/stages.js';
import {
  createStoreIdentifiedOwnerRouter,
  createStoreIdentifiedOwnerRouterFactory,
  isStoreIdentified,
  type StoreIdentifiedOwnerRouterDeps,
} from '../../src/owner/router.js';
import { StoreScopedReportError } from '../../src/report/errors.js';
import type { ReportHandleInput, ReportHandler } from '../../src/report/handler.js';
import type { InboundEvent } from '../../src/webhook/dispatch.js';

type Stage = OnboardingSessionRow['stage'];

const STAGES: readonly Stage[] = ['await_invite_code', 'await_store_name', 'await_confirmation', 'completed'];
const NOT_COMPLETED_STAGES: readonly Stage[] = ['await_invite_code', 'await_store_name', 'await_confirmation'];
const KINDS: readonly ReportKind[] = ['new_reviews', 'comparison', 'trend'];

const LINE_USER_ID = 'U0000000000000000000000000000test';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STORE_ID = '11111111-1111-4111-8111-111111111111';
const REPLY_TOKEN = 'reply-token-router-1';
const COMPLETED_MENU_ID = 'richmenu-completed-test';
const FIXED_NOW = new Date('2026-09-15T03:00:00Z');

// 偽物のセッション・レポート・Messenger を通すので、DB へ直接は触れない。触れたら試験の前提が崩れているので落とす。
const DB = {
  query: vi.fn(() => {
    throw new Error('the router must reach the database through the injected accessors');
  }),
} as unknown as Queryable;

function owner(overrides: Partial<OwnerRow> = {}): OwnerRow {
  return {
    id: OWNER_ID,
    agency_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    line_user_id: LINE_USER_ID,
    display_name: null,
    onboarding_status: 'store_identified',
    created_at: FIXED_NOW,
    delivery_hour: 7,
    ...overrides,
  };
}

function session(stage: Stage): OnboardingSessionRow {
  return {
    line_user_id: LINE_USER_ID,
    stage,
    // ck_session_owner_stage（stage = await_invite_code ⇔ owner_id IS NULL）に合わせる。
    owner_id: stage === 'await_invite_code' ? null : OWNER_ID,
    candidates: null,
    selected_index: null,
    invite_failures: 0,
    locked_until: null,
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
  };
}

// --- イベント ------------------------------------------------------------------------

function textEvent(text: string): InboundEvent {
  return { kind: 'text', lineUserId: LINE_USER_ID, replyToken: REPLY_TOKEN, text };
}

function postbackEvent(data: string): InboundEvent {
  return { kind: 'postback', lineUserId: LINE_USER_ID, replyToken: REPLY_TOKEN, data };
}

const FOLLOW: InboundEvent = { kind: 'follow', lineUserId: LINE_USER_ID, replyToken: REPLY_TOKEN };
const STICKER: InboundEvent = { kind: 'unsupported', lineUserId: LINE_USER_ID, replyToken: REPLY_TOKEN };
const RESUME = postbackEvent(encodePostback({ kind: 'resume' }));

// レポートの postback。メニューの区画の形（店舗も頁も無い）と、店舗の選択肢の形（店舗つき・頁つき）。
const REPORT_REQUESTS: readonly ReportRequest[] = KINDS.flatMap((kind) => [
  { kind, storeId: null, page: 0 },
  { kind, storeId: STORE_ID, page: 0 },
  { kind, storeId: null, page: 1 },
  { kind, storeId: STORE_ID, page: 2 },
]);

// レポートでもオンボーディングの再開でもない postback。オンボーディングの候補の選択・確定・やり直し、古い形・壊れた形。
const OTHER_POSTBACK_DATA: readonly string[] = [
  encodePostback({ kind: 'select_candidate', index: 0 }),
  encodePostback({ kind: 'confirm' }),
  encodePostback({ kind: 'restart' }),
  'a=rpt&k=xx',
  'a=rpt',
  'a=g_post',
  'garbage',
  '',
];

// ステータス案内を返すべきイベント（レポートの postback 以外のすべて）。
const STATUS_EVENTS: ReadonlyArray<readonly [string, InboundEvent]> = [
  ['テキスト「ステータス確認」', textEvent('ステータス確認')],
  ['招待コードに見えるテキスト', textEvent('ABCD-1234')],
  ['店名に見えるテキスト', textEvent('試験食堂')],
  ['スタンプなど', STICKER],
  ['友だち追加', FOLLOW],
  ['再開の postback', RESUME],
  ...OTHER_POSTBACK_DATA.map((data): readonly [string, InboundEvent] => [`postback「${data}」`, postbackEvent(data)]),
];

// --- 偽物 --------------------------------------------------------------------------

interface ReplyCall {
  readonly replyToken: string;
  readonly messages: readonly LineMessage[];
}

interface LogCall {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: LogFields | undefined;
}

interface SetupOptions {
  readonly stage?: Stage;
  readonly owner?: OwnerRow;
  readonly sessionError?: Error;
  readonly replyError?: Error;
  readonly reportError?: Error;
  readonly linkError?: Error;
  readonly updateError?: Error;
  readonly auditError?: Error;
  /** false なら監査記録の手段を渡さない（任意の依存）。 */
  readonly withAudit?: boolean;
}

function setup(options: SetupOptions = {}) {
  let current = session(options.stage ?? 'completed');
  // 呼ばれた順。Reply（ステータス案内かレポート）の後にメニューを張り、その後に段階を揃えることを確かめる。
  const timeline: string[] = [];
  const replies: ReplyCall[] = [];
  const reportInputs: ReportHandleInput[] = [];
  const links: Array<{ readonly lineUserId: string; readonly richMenuId: string }> = [];
  const updates: Array<{ readonly db: Queryable; readonly lineUserId: string; readonly patch: SessionPatch }> = [];
  const logs: LogCall[] = [];
  const audits: AuditLogInput[] = [];

  const sessions: SessionsAccessor = {
    async getOrCreateSession(_db, lineUserId) {
      timeline.push('session');
      if (options.sessionError) throw options.sessionError;
      expect(lineUserId).toBe(LINE_USER_ID);
      return current;
    },
    async updateSession(db, lineUserId, patch) {
      timeline.push('update');
      if (options.updateError) throw options.updateError;
      updates.push({ db, lineUserId, patch });
      current = {
        ...current,
        stage: patch.stage ?? current.stage,
        owner_id: patch.ownerId !== undefined ? patch.ownerId : current.owner_id,
      };
    },
  };

  const messenger: LineMessenger = {
    async reply(replyToken, messages) {
      timeline.push('reply');
      if (options.replyError) throw options.replyError;
      replies.push({ replyToken, messages });
    },
    async getProfile() {
      throw new Error('the router must not read the profile');
    },
    async linkRichMenu(lineUserId, richMenuId) {
      timeline.push('link');
      links.push({ lineUserId, richMenuId });
      if (options.linkError) throw options.linkError;
    },
  };

  const reports: ReportHandler = {
    async handle(input) {
      timeline.push('report');
      if (options.reportError) throw options.reportError;
      reportInputs.push(input);
      return 'report';
    },
  };

  const deps: StoreIdentifiedOwnerRouterDeps = {
    db: DB,
    sessions,
    messenger,
    reports,
    logger: {
      info: (event, fields) => logs.push({ level: 'info', event, fields }),
      warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
    },
    ...(options.withAudit === false
      ? {}
      : {
          auditLog: async (input: AuditLogInput) => {
            timeline.push('audit');
            if (options.auditError) throw options.auditError;
            audits.push(input);
          },
        }),
    lineRichMenuCompletedId: COMPLETED_MENU_ID,
  };

  const router = createStoreIdentifiedOwnerRouter(deps);
  return {
    handle: (event: InboundEvent) => router.handleEvent(event, options.owner ?? owner()),
    timeline,
    replies,
    reportInputs,
    links,
    updates,
    logs,
    audits,
    stage: () => current.stage,
  };
}

type Harness = ReturnType<typeof setup>;

function expectStatusGuidanceOnly(h: Harness): void {
  expect(h.replies).toEqual([{ replyToken: REPLY_TOKEN, messages: [buildStatusGuidanceMessage()] }]);
  expect(h.reportInputs).toEqual([]);
}

function expectLinkedOnce(h: Harness): void {
  expect(h.links).toEqual([{ lineUserId: LINE_USER_ID, richMenuId: COMPLETED_MENU_ID }]);
  expect(h.logs.filter((log) => log.event.startsWith('line-webhook.richmenu_'))).toEqual([
    { level: 'info', event: 'line-webhook.richmenu_linked', fields: undefined },
  ]);
  expect(h.audits).toEqual([
    { actorType: 'owner', actorId: OWNER_ID, action: 'rich_menu_linked', targetType: 'owner', targetId: OWNER_ID },
  ]);
}

function expectNotLinked(h: Harness): void {
  expect(h.links).toEqual([]);
  expect(h.updates).toEqual([]);
  expect(h.logs.filter((log) => log.event.startsWith('line-webhook.richmenu_'))).toEqual([]);
  expect(h.audits).toEqual([]);
}

// --- 判定 --------------------------------------------------------------------------

describe('isStoreIdentified', () => {
  it('onboarding_status が store_identified のオーナーだけを店舗特定済みとみなす', () => {
    expect(isStoreIdentified(owner())).toBe(true);
    expect(isStoreIdentified(owner({ onboarding_status: 'pending' }))).toBe(false);
    // active はどのコードも書かない値である。設計の判定（= 'store_identified'）どおり、店舗特定済みに数えない。
    expect(isStoreIdentified(owner({ onboarding_status: 'active' }))).toBe(false);
    expect(isStoreIdentified(null)).toBe(false);
  });
});

// --- 振り分け ----------------------------------------------------------------------

describe('振り分け', () => {
  it.each(REPORT_REQUESTS.map((request) => [encodeReportPostback(request), request] as const))(
    'レポートの postback「%s」はレポートへ渡し、ステータス案内を返さない',
    async (data, request) => {
      const h = setup();
      await h.handle(postbackEvent(data));

      expect(h.reportInputs).toEqual([{ replyToken: REPLY_TOKEN, ownerId: OWNER_ID, request }]);
      expect(h.replies).toEqual([]);
    },
  );

  it.each(STATUS_EVENTS)('%s にはステータス案内を 1 回だけ返し、レポートへ渡さない', async (_label, event) => {
    const h = setup();
    await h.handle(event);

    expectStatusGuidanceOnly(h);
  });

  // 2.9: 段階が completed でないオーナー（代理店経路で店舗が登録された人）にも、オンボーディングの案内を返さない。
  describe.each(STAGES)('会話の段階が %s でも', (stage) => {
    it.each(STATUS_EVENTS)('%s にはオンボーディングの案内ではなくステータス案内を返す', async (_label, event) => {
      const h = setup({ stage });
      await h.handle(event);

      expectStatusGuidanceOnly(h);
      const onboardingTexts = [buildGreetingMessage(), buildStoreNameInputGuidanceMessage()].map(textOf);
      for (const reply of h.replies) {
        for (const message of reply.messages) {
          expect(onboardingTexts).not.toContain(textOf(message));
          expect(textOf(message)).not.toContain('招待コード');
          expect(textOf(message)).not.toContain('お店の名前');
        }
      }
    });

    it.each(KINDS)('レポート %s の postback はレポートへ渡す', async (kind) => {
      const h = setup({ stage });
      await h.handle(postbackEvent(encodeReportPostback({ kind, storeId: null, page: 0 })));

      expect(h.reportInputs).toEqual([
        { replyToken: REPLY_TOKEN, ownerId: OWNER_ID, request: { kind, storeId: null, page: 0 } },
      ]);
      expect(h.replies).toEqual([]);
    });
  });
});

function textOf(message: LineMessage): string {
  return message.type === 'text' ? message.text : message.altText;
}

// --- メニューの照合 ----------------------------------------------------------------

describe('メニューの照合', () => {
  describe.each(NOT_COMPLETED_STAGES)('会話の段階が %s（completed でない）', (stage) => {
    const events: ReadonlyArray<readonly [string, InboundEvent]> = [
      ...STATUS_EVENTS,
      ...KINDS.map((kind): readonly [string, InboundEvent] => [
        `レポート ${kind} の postback`,
        postbackEvent(encodeReportPostback({ kind, storeId: null, page: 0 })),
      ]),
    ];

    it.each(events)('%s の Reply の後に完了後メニューを張り、段階を completed に揃える', async (_label, event) => {
      const h = setup({ stage });
      await h.handle(event);

      expectLinkedOnce(h);
      // ownerId も同じ更新で渡す。await_invite_code のまま（owner_id が NULL）の行でも CHECK 制約を満たすため。
      expect(h.updates).toEqual([
        { db: DB, lineUserId: LINE_USER_ID, patch: { stage: 'completed', ownerId: OWNER_ID } },
      ]);
      expect(h.stage()).toBe('completed');
      const replied = event.kind === 'postback' && decodeReportPostback(event.data) !== null ? 'report' : 'reply';
      expect(h.timeline.filter((step) => step !== 'audit')).toEqual(['session', replied, 'link', 'update']);
    });

    it('張れなければ段階を変えず、失敗を記録し、例外を投げない（Reply は済んでいる）', async () => {
      const h = setup({ stage, linkError: new TypeError('link failed') });
      await expect(h.handle(textEvent('ステータス確認'))).resolves.toBeUndefined();

      expectStatusGuidanceOnly(h);
      expect(h.links).toHaveLength(1);
      expect(h.updates).toEqual([]);
      expect(h.stage()).toBe(stage);
      expect(h.logs).toEqual([
        { level: 'warn', event: 'line-webhook.richmenu_link_failed', fields: { errorKind: 'TypeError' } },
      ]);
      expect(h.audits).toEqual([
        {
          actorType: 'owner',
          actorId: OWNER_ID,
          action: 'rich_menu_link_failed',
          targetType: 'owner',
          targetId: OWNER_ID,
        },
      ]);
    });

    it('同じオーナーの次の操作で、もう一度張って段階を揃える', async () => {
      const failing = setup({ stage, linkError: new Error('link failed') });
      await failing.handle(textEvent('ステータス確認'));
      expect(failing.stage()).toBe(stage);

      const next = setup({ stage: failing.stage() });
      await next.handle(textEvent('ステータス確認'));
      expectLinkedOnce(next);
      expect(next.stage()).toBe('completed');
    });
  });

  describe('会話の段階が completed', () => {
    it.each<readonly [string, InboundEvent]>([
      ['友だち追加', FOLLOW],
      ['再開の postback', RESUME],
    ])('%s では完了後メニューを張り直し、段階は更新しない', async (_label, event) => {
      const h = setup({ stage: 'completed' });
      await h.handle(event);

      expectStatusGuidanceOnly(h);
      expectLinkedOnce(h);
      expect(h.updates).toEqual([]);
      expect(h.timeline.filter((step) => step !== 'audit')).toEqual(['session', 'reply', 'link']);
    });

    it.each<readonly [string, InboundEvent]>([
      ['友だち追加', FOLLOW],
      ['再開の postback', RESUME],
    ])('%s で張れなくても例外を投げず、段階を変えない', async (_label, event) => {
      const h = setup({ stage: 'completed', linkError: new Error('link failed') });
      await expect(h.handle(event)).resolves.toBeUndefined();

      expectStatusGuidanceOnly(h);
      expect(h.links).toHaveLength(1);
      expect(h.updates).toEqual([]);
      expect(h.logs.map((log) => log.event)).toEqual(['line-webhook.richmenu_link_failed']);
      expect(h.audits.map((audit) => audit.action)).toEqual(['rich_menu_link_failed']);
    });

    const unlinked: ReadonlyArray<readonly [string, InboundEvent]> = [
      ...STATUS_EVENTS.filter(([, event]) => event !== FOLLOW && event !== RESUME),
      ...REPORT_REQUESTS.map((request): readonly [string, InboundEvent] => [
        `レポートの postback「${encodeReportPostback(request)}」`,
        postbackEvent(encodeReportPostback(request)),
      ]),
    ];

    it.each(unlinked)('%s では張らない', async (_label, event) => {
      const h = setup({ stage: 'completed' });
      await h.handle(event);

      expectNotLinked(h);
      expect(h.replies.length + h.reportInputs.length).toBe(1);
    });
  });

  it('段階の更新に失敗しても例外を投げず、張れたことと更新の失敗を記録する', async () => {
    const h = setup({ stage: 'await_store_name', updateError: new RangeError('update failed') });
    await expect(h.handle(textEvent('ステータス確認'))).resolves.toBeUndefined();

    expectStatusGuidanceOnly(h);
    expect(h.links).toHaveLength(1);
    expect(h.stage()).toBe('await_store_name');
    expect(h.logs).toEqual([
      { level: 'info', event: 'line-webhook.richmenu_linked', fields: undefined },
      { level: 'warn', event: 'line-webhook.session_stage_update_failed', fields: { errorKind: 'RangeError' } },
    ]);
    expect(h.audits.map((audit) => audit.action)).toEqual(['rich_menu_linked']);
  });

  it('監査記録に失敗しても例外を投げず、張れたことを記録し、段階を揃える', async () => {
    const h = setup({ stage: 'await_store_name', auditError: new SyntaxError('audit failed') });
    await expect(h.handle(textEvent('ステータス確認'))).resolves.toBeUndefined();

    expect(h.stage()).toBe('completed');
    expect(h.logs).toEqual([
      { level: 'info', event: 'line-webhook.richmenu_linked', fields: undefined },
      { level: 'warn', event: 'line-webhook.audit_log_failed', fields: { errorKind: 'SyntaxError' } },
    ]);
  });

  it('監査記録の手段が無くても、張って段階を揃え、事象を記録する', async () => {
    const h = setup({ stage: 'await_confirmation', withAudit: false });
    await h.handle(FOLLOW);

    expect(h.links).toHaveLength(1);
    expect(h.stage()).toBe('completed');
    expect(h.logs.map((log) => log.event)).toEqual(['line-webhook.richmenu_linked']);
  });

  it('記録に店舗 ID と LINE ユーザー ID を載せない', async () => {
    // 例外の本文に識別子を入れ、本文が記録へ流れないことも確かめる。
    const leaky = (): Error => new Error(`${LINE_USER_ID} ${STORE_ID}`);
    const linkingEvents: InboundEvent[] = [
      postbackEvent(encodeReportPostback({ kind: 'trend', storeId: STORE_ID, page: 1 })),
      FOLLOW,
      RESUME,
      textEvent(STORE_ID),
    ];
    const cases: ReadonlyArray<readonly [SetupOptions, readonly InboundEvent[]]> = [
      [{ stage: 'await_store_name' }, linkingEvents],
      [{ stage: 'await_store_name', linkError: leaky() }, linkingEvents],
      [{ stage: 'await_store_name', updateError: leaky() }, linkingEvents],
      [{ stage: 'await_store_name', auditError: leaky() }, linkingEvents],
      [{ stage: 'completed', linkError: leaky() }, [FOLLOW, RESUME]],
    ];
    for (const [options, events] of cases) {
      for (const event of events) {
        const h = setup(options);
        await h.handle(event);
        // 記録が 1 件も無ければ、この照合は何も確かめていない。
        expect(h.logs.length).toBeGreaterThan(0);
        const serialized = JSON.stringify(h.logs);
        expect(serialized).not.toContain(LINE_USER_ID);
        expect(serialized).not.toContain(STORE_ID);
      }
    }
  });
});

// --- 例外 --------------------------------------------------------------------------

describe('例外', () => {
  it('レポートの店舗つきの例外はそのまま伝え、メニューを張らない（Reply はエラー境界が返す）', async () => {
    const error = new StoreScopedReportError('試験食堂 駅前店', { cause: new Error('read failed') });
    const h = setup({ stage: 'await_store_name', reportError: error });

    await expect(h.handle(postbackEvent(encodeReportPostback({ kind: 'comparison', storeId: null, page: 0 })))).rejects.toBe(
      error,
    );
    expect(h.replies).toEqual([]);
    expect(h.links).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.stage()).toBe('await_store_name');
  });

  it('ステータス案内の Reply が例外を投げたら、そのまま伝え、メニューを張らない', async () => {
    const error = new Error('token issuance failed');
    const h = setup({ stage: 'await_store_name', replyError: error });

    await expect(h.handle(FOLLOW)).rejects.toBe(error);
    expect(h.links).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it('セッションを読めなければ、Reply を送る前に例外を伝える', async () => {
    const error = new Error('session read failed');
    const h = setup({ sessionError: error });

    await expect(h.handle(textEvent('ステータス確認'))).rejects.toBe(error);
    expect(h.timeline).toEqual(['session']);
  });

  it.each([
    ['pending のオーナー', owner({ onboarding_status: 'pending' })],
    ['別の LINE ユーザーのオーナー', owner({ line_user_id: 'U-another-user' })],
  ])('%s を渡されたら、何も送らず・張らずに例外を投げる（呼出元の誤り）', async (_label, given) => {
    const h = setup({ stage: 'await_store_name', owner: given });

    await expect(h.handle(FOLLOW)).rejects.toThrow();
    expect(h.timeline).toEqual([]);
  });
});

// --- 2 つの復号 --------------------------------------------------------------------

describe('オンボーディングの復号とレポートの復号は、互いの data を受理しない', () => {
  // レポートの data はすべての種類と、店舗・頁の有無の組み合わせを実際の符号化器で作る。
  const reportData = KINDS.flatMap((kind) =>
    [null, STORE_ID].flatMap((storeId) => [0, 1, 99].map((page) => encodeReportPostback({ kind, storeId, page }))),
  );
  // オンボーディングの data は、すべての action を実際の符号化器で作る。
  const onboardingActions: readonly PostbackAction[] = [
    { kind: 'select_candidate', index: 0 },
    { kind: 'select_candidate', index: 1 },
    { kind: 'select_candidate', index: 9 },
    { kind: 'confirm' },
    { kind: 'restart' },
    { kind: 'resume' },
  ];
  const onboardingData = onboardingActions.map(encodePostback);

  it('試験の data はそれぞれの復号器が受理する形である（空振りしていない）', () => {
    expect(reportData).toHaveLength(18);
    expect(new Set(reportData).size).toBe(reportData.length);
    for (const data of reportData) expect(decodeReportPostback(data)).not.toBeNull();
    for (const [index, data] of onboardingData.entries()) expect(decodePostback(data)).toEqual(onboardingActions[index]);
  });

  it.each(reportData)('オンボーディングの復号はレポートの data「%s」を受理しない', (data) => {
    expect(decodePostback(data)).toBeNull();
  });

  it.each(onboardingData)('レポートの復号はオンボーディングの data「%s」を受理しない', (data) => {
    expect(decodeReportPostback(data)).toBeNull();
  });
});

// --- リクエストごとの作成 ----------------------------------------------------------

// line-on-demand-report tasks 3.10: 合成ルートは、router と ReportHandler をリクエストごとに、そのリクエストの
// ロガー（相関 ID つき）と Messenger で作る。ReportHandler はロガーを作成時に固定するので、1 度だけ作って使い回すと、
// 2 つ目以降のリクエストの応答が最初のリクエストのロガーと Messenger へ流れる。
describe('createStoreIdentifiedOwnerRouterFactory', () => {
  const STORE_NAME = '試験食堂 駅前店';

  function scope() {
    const replies: ReplyCall[] = [];
    const logs: LogCall[] = [];
    const messenger: LineMessenger = {
      async reply(replyToken, messages) {
        replies.push({ replyToken, messages });
      },
      async getProfile() {
        throw new Error('the router must not read the profile');
      },
      async linkRichMenu() {
        throw new Error('a completed session with a report request must not relink');
      },
    };
    const logger = {
      info: (event: string, fields?: LogFields) => logs.push({ level: 'info', event, fields }),
      warn: (event: string, fields?: LogFields) => logs.push({ level: 'warn', event, fields }),
    };
    return { scope: { logger, messenger }, replies, logs };
  }

  it('作った router は、渡されたリクエストのロガーと Messenger でレポートに応える', async () => {
    const factory = createStoreIdentifiedOwnerRouterFactory({
      db: DB,
      sessions: {
        getOrCreateSession: async () => session('completed'),
        updateSession: async () => {
          throw new Error('a completed session must not be updated');
        },
      },
      lineRichMenuCompletedId: COMPLETED_MENU_ID,
      liffStoreDetailUrl: 'https://liff.line.me/test-liff-id',
      reads: {
        listReportableStores: async () => [{ id: STORE_ID, name: STORE_NAME }],
        findLatestDailySummary: async () => null,
        listDailySummariesEndingAt: async () => [],
      },
      now: () => FIXED_NOW,
    });
    const report = postbackEvent(encodeReportPostback({ kind: 'comparison', storeId: null, page: 0 }));
    const first = scope();
    const second = scope();

    await factory(first.scope).handleEvent(report, owner());
    await factory(second.scope).handleEvent(report, owner());

    for (const request of [first, second]) {
      expect(request.replies).toHaveLength(1);
      expect(request.logs).toEqual([
        {
          level: 'info',
          event: 'line-webhook.report_replied',
          fields: { reportKind: 'comparison', reportOutcome: 'preparing' },
        },
      ]);
    }
  });
});

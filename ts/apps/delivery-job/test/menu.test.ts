// 完了後メニューの準備判定とオーナーの照合（menu.ts・tasks 4.2）の試験。
//
// 偽の LINE クライアント（注入）で、設計（design.md「ReportMenuGate」）の分岐をすべて固定する。
//   - 準備判定の成立・不成立・照会の失敗と、実行ごとに 1 回だけ照会して結果を使い回すこと
//   - オーナーの照合の 3 分岐（already_linked・linked・link_failed）と、照会の失敗
//   - 記録（ログ）に LINE ユーザー ID と店舗 ID が 1 文字も現れないこと
//
// 準備判定は「対象の有無によらず実行ごとに 1 回」なので、対象を 1 件も処理しない（ensureOwner を
// 呼ばない）実行でも照会が成立することを併せて固定する。
import { describe, expect, it } from 'vitest';

import { encodeReportPostback, type ReportKind, type RichMenuActionLike } from '@fwlm/line-report';
import type { LogFields } from '@fwlm/observability';

import { createReportMenuGate } from '../src/menu.js';
import type { ReportMenuLineClient, ReportMenuLogger } from '../src/menu.js';
import type { UserRichMenuLookup } from '../src/line.js';

const ACCESS_TOKEN = 'stateless-access-token';
const COMPLETED_MENU_ID = 'richmenu-0123456789abcdef0123456789abcdef';
const OTHER_MENU_ID = 'richmenu-fedcba9876543210fedcba9876543210';

// LINE のユーザー識別子に似せた試験用の値（実在しない）。記録に現れないことの照合にも使う。
const OWNER_A = 'Ufake00000000000000000000000000aa';
const OWNER_B = 'Ufake00000000000000000000000000bb';

// stores.id と同じ uuid の形の値（実在の店舗とは無関係）。
const STORE_ID = '3f2c9a4e-1b7d-4c8e-9a51-6d0e2f7b8c13';

// --- 偽の LINE クライアント ----------------------------------------------------------

interface FakeLineBehavior {
  readonly actions?: () => Promise<RichMenuActionLike[] | null>;
  readonly userMenu?: (lineUserId: string) => Promise<UserRichMenuLookup>;
  readonly link?: (lineUserId: string, richMenuId: string) => Promise<boolean>;
}

interface FakeLine {
  readonly client: ReportMenuLineClient;
  /** 照会したリッチメニューの ID（呼出ごとに 1 件）。 */
  readonly actionsCalls: string[];
  /** 照会したオーナーの LINE ユーザー ID（呼出ごとに 1 件）。 */
  readonly userMenuCalls: string[];
  readonly linkCalls: Array<{ readonly lineUserId: string; readonly richMenuId: string }>;
}

function fakeLine(behavior: FakeLineBehavior): FakeLine {
  const actionsCalls: string[] = [];
  const userMenuCalls: string[] = [];
  const linkCalls: Array<{ readonly lineUserId: string; readonly richMenuId: string }> = [];

  const client: ReportMenuLineClient = {
    async getRichMenuActions(accessToken, richMenuId) {
      expect(accessToken).toBe(ACCESS_TOKEN);
      actionsCalls.push(richMenuId);
      if (behavior.actions === undefined) {
        throw new Error('fakeLine: getRichMenuActions was not expected to be called');
      }
      return behavior.actions();
    },
    async getUserRichMenuId(accessToken, lineUserId) {
      expect(accessToken).toBe(ACCESS_TOKEN);
      userMenuCalls.push(lineUserId);
      if (behavior.userMenu === undefined) {
        throw new Error('fakeLine: getUserRichMenuId was not expected to be called');
      }
      return behavior.userMenu(lineUserId);
    },
    async linkUserRichMenu(accessToken, lineUserId, richMenuId) {
      expect(accessToken).toBe(ACCESS_TOKEN);
      linkCalls.push({ lineUserId, richMenuId });
      if (behavior.link === undefined) {
        throw new Error('fakeLine: linkUserRichMenu was not expected to be called');
      }
      return behavior.link(lineUserId, richMenuId);
    },
  };

  return { client, actionsCalls, userMenuCalls, linkCalls };
}

// --- 記録の受け皿 --------------------------------------------------------------------

interface RecordedLog {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: LogFields | undefined;
}

interface RecordingLogger {
  readonly logger: ReportMenuLogger;
  readonly entries: RecordedLog[];
}

function recordingLogger(): RecordingLogger {
  const entries: RecordedLog[] = [];
  return {
    entries,
    logger: {
      info(event, fields) {
        entries.push({ level: 'info', event, fields });
      },
      warn(event, fields) {
        entries.push({ level: 'warn', event, fields });
      },
    },
  };
}

function eventsOf(entries: readonly RecordedLog[]): string[] {
  return entries.map((entry) => entry.event);
}

// --- メニューの区画 ------------------------------------------------------------------

/** メニューの区画が使う形（店舗も頁も持たない postback）。 */
function menuPostback(kind: ReportKind): RichMenuActionLike {
  return { type: 'postback', data: encodeReportPostback({ kind, storeId: null, page: 0 }) };
}

/** レポート 3 導線がそろった完了後メニューの区画（下段は uri と message）。 */
const READY_ACTIONS: readonly RichMenuActionLike[] = [
  menuPostback('new_reviews'),
  menuPostback('comparison'),
  menuPostback('trend'),
  { type: 'uri' },
  { type: 'message' },
];

function gateWith(behavior: FakeLineBehavior): {
  readonly gate: ReturnType<typeof createReportMenuGate>;
  readonly line: FakeLine;
  readonly log: RecordingLogger;
} {
  const line = fakeLine(behavior);
  const log = recordingLogger();
  const gate = createReportMenuGate({
    lineClient: line.client,
    completedRichMenuId: COMPLETED_MENU_ID,
    logger: log.logger,
  });
  return { gate, line, log };
}

// --- 準備判定 ------------------------------------------------------------------------

describe('ReportMenuGate.checkReady', () => {
  it('レポート 3 導線がそろった完了後メニューを ready と判定し、記録を出さない', async () => {
    const { gate, line, log } = gateWith({ actions: async () => [...READY_ACTIONS] });

    await expect(gate.checkReady(ACCESS_TOKEN)).resolves.toBe('ready');

    expect(line.actionsCalls).toEqual([COMPLETED_MENU_ID]);
    expect(log.entries).toEqual([]);
  });

  it('対象を 1 件も処理しない実行でも、設定されたメニューを 1 回照会する', async () => {
    // 準備判定は対象の有無によらない（design.md「対象の有無によらず実行ごとに 1 回だけ照会」）。
    const { gate, line } = gateWith({ actions: async () => [...READY_ACTIONS] });

    await expect(gate.checkReady(ACCESS_TOKEN)).resolves.toBe('ready');

    expect(line.actionsCalls).toHaveLength(1);
    expect(line.userMenuCalls).toEqual([]);
    expect(line.linkCalls).toEqual([]);
  });

  it('導線が 1 つ欠けたメニューを not_ready と判定し、未準備の事象を出す', async () => {
    const missing = READY_ACTIONS.filter((action) => action.data !== menuPostback('trend').data);
    const { gate, log } = gateWith({ actions: async () => [...missing] });

    await expect(gate.checkReady(ACCESS_TOKEN)).resolves.toBe('not_ready');

    expect(eventsOf(log.entries)).toEqual(['delivery-job.report_menu_not_ready']);
    expect(log.entries[0]?.level).toBe('warn');
  });

  it('店舗つきの postback しか持たない導線は、そろっていないとみなす', async () => {
    // 共有の判定（@fwlm/line-report の exposesAllReportActions）は、店舗つき・頁つきの data を
    // メニューの区画として数えない。ここを数えると、押しても答えの返らない導線へ誘導する。
    const scoped: RichMenuActionLike[] = [
      { type: 'postback', data: encodeReportPostback({ kind: 'new_reviews', storeId: STORE_ID, page: 0 }) },
      menuPostback('comparison'),
      menuPostback('trend'),
    ];
    const { gate, log } = gateWith({ actions: async () => scoped });

    await expect(gate.checkReady(ACCESS_TOKEN)).resolves.toBe('not_ready');
    expect(eventsOf(log.entries)).toEqual(['delivery-job.report_menu_not_ready']);
  });

  it('未知の種類の符号を持つ postback は導線として数えない', async () => {
    const unknown: RichMenuActionLike[] = [
      { type: 'postback', data: 'a=rpt&k=xx' },
      menuPostback('comparison'),
      menuPostback('trend'),
    ];
    const { gate } = gateWith({ actions: async () => unknown });

    await expect(gate.checkReady(ACCESS_TOKEN)).resolves.toBe('not_ready');
  });

  it('照会が失敗した実行は not_ready とし、未準備の事象を出す', async () => {
    const { gate, log } = gateWith({ actions: async () => null });

    await expect(gate.checkReady(ACCESS_TOKEN)).resolves.toBe('not_ready');

    expect(eventsOf(log.entries)).toEqual(['delivery-job.report_menu_not_ready']);
  });

  it('照会が例外で終わっても投げず、not_ready として記録に残す', async () => {
    const { gate, log } = gateWith({
      actions: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(gate.checkReady(ACCESS_TOKEN)).resolves.toBe('not_ready');

    expect(eventsOf(log.entries)).toEqual(['delivery-job.report_menu_not_ready']);
    expect(log.entries[0]?.fields?.errorKind).toBe('TypeError');
  });

  it('実行内で 2 回呼んでも照会は 1 回だけで、事象も 1 回だけ出す', async () => {
    const { gate, line, log } = gateWith({ actions: async () => null });

    await expect(gate.checkReady(ACCESS_TOKEN)).resolves.toBe('not_ready');
    await expect(gate.checkReady(ACCESS_TOKEN)).resolves.toBe('not_ready');

    expect(line.actionsCalls).toHaveLength(1);
    expect(eventsOf(log.entries)).toEqual(['delivery-job.report_menu_not_ready']);
  });

  it('同時に呼んでも照会は 1 回だけになる', async () => {
    const { gate, line } = gateWith({ actions: async () => [...READY_ACTIONS] });

    const results = await Promise.all([gate.checkReady(ACCESS_TOKEN), gate.checkReady(ACCESS_TOKEN)]);

    expect(results).toEqual(['ready', 'ready']);
    expect(line.actionsCalls).toHaveLength(1);
  });
});

// --- オーナーの照合 ------------------------------------------------------------------

describe('ReportMenuGate.ensureOwner', () => {
  it('オーナーが設定と同じメニューを見ていれば already_linked で、張り直さない', async () => {
    const { gate, line, log } = gateWith({
      userMenu: async () => ({ kind: 'linked', richMenuId: COMPLETED_MENU_ID }),
    });

    await expect(gate.ensureOwner(ACCESS_TOKEN, OWNER_A)).resolves.toBe('already_linked');

    expect(line.userMenuCalls).toEqual([OWNER_A]);
    expect(line.linkCalls).toEqual([]);
    expect(log.entries).toEqual([]);
  });

  it('個別のメニューが無いオーナー（404）へは張り、linked を返す', async () => {
    const { gate, line, log } = gateWith({
      userMenu: async () => ({ kind: 'not_linked' }),
      link: async () => true,
    });

    await expect(gate.ensureOwner(ACCESS_TOKEN, OWNER_A)).resolves.toBe('linked');

    expect(line.linkCalls).toEqual([{ lineUserId: OWNER_A, richMenuId: COMPLETED_MENU_ID }]);
    expect(eventsOf(log.entries)).toEqual(['delivery-job.richmenu_linked']);
    expect(log.entries[0]?.level).toBe('info');
  });

  it('別のメニューを見ているオーナーへは張り替え、linked を返す', async () => {
    const { gate, line, log } = gateWith({
      userMenu: async () => ({ kind: 'linked', richMenuId: OTHER_MENU_ID }),
      link: async () => true,
    });

    await expect(gate.ensureOwner(ACCESS_TOKEN, OWNER_A)).resolves.toBe('linked');

    expect(line.linkCalls).toEqual([{ lineUserId: OWNER_A, richMenuId: COMPLETED_MENU_ID }]);
    expect(eventsOf(log.entries)).toEqual(['delivery-job.richmenu_linked']);
  });

  it('張れなかったときは link_failed とし、失敗の事象を出す', async () => {
    const { gate, line, log } = gateWith({
      userMenu: async () => ({ kind: 'not_linked' }),
      link: async () => false,
    });

    await expect(gate.ensureOwner(ACCESS_TOKEN, OWNER_A)).resolves.toBe('link_failed');

    expect(line.linkCalls).toHaveLength(1);
    expect(eventsOf(log.entries)).toEqual(['delivery-job.richmenu_link_failed']);
    expect(log.entries[0]?.level).toBe('warn');
  });

  it('照会が失敗したオーナーは link_failed とし、張りに行かない', async () => {
    // 照会できない状態を「同じメニューを見ている」とみなすと、導線の無いメニューのまま誘導する。
    const { gate, line, log } = gateWith({
      userMenu: async () => ({ kind: 'lookup_failed', httpStatus: 500 }),
    });

    await expect(gate.ensureOwner(ACCESS_TOKEN, OWNER_A)).resolves.toBe('link_failed');

    expect(line.linkCalls).toEqual([]);
    expect(eventsOf(log.entries)).toEqual(['delivery-job.richmenu_link_failed']);
  });

  it('照会や張りが例外で終わっても投げず、link_failed として記録に残す', async () => {
    const { gate, log } = gateWith({
      userMenu: async () => ({ kind: 'not_linked' }),
      link: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(gate.ensureOwner(ACCESS_TOKEN, OWNER_A)).resolves.toBe('link_failed');

    expect(eventsOf(log.entries)).toEqual(['delivery-job.richmenu_link_failed']);
    expect(log.entries[0]?.fields?.errorKind).toBe('TypeError');
  });

  it('同じオーナーを 2 回照合しても、照会と張りは 1 回だけになる', async () => {
    const { gate, line, log } = gateWith({
      userMenu: async () => ({ kind: 'not_linked' }),
      link: async () => true,
    });

    await expect(gate.ensureOwner(ACCESS_TOKEN, OWNER_A)).resolves.toBe('linked');
    await expect(gate.ensureOwner(ACCESS_TOKEN, OWNER_A)).resolves.toBe('linked');

    expect(line.userMenuCalls).toEqual([OWNER_A]);
    expect(line.linkCalls).toHaveLength(1);
    expect(eventsOf(log.entries)).toEqual(['delivery-job.richmenu_linked']);
  });

  it('別のオーナーはそれぞれ照合する', async () => {
    const { gate, line } = gateWith({
      userMenu: async (lineUserId) =>
        lineUserId === OWNER_A ? { kind: 'linked', richMenuId: COMPLETED_MENU_ID } : { kind: 'not_linked' },
      link: async () => true,
    });

    await expect(gate.ensureOwner(ACCESS_TOKEN, OWNER_A)).resolves.toBe('already_linked');
    await expect(gate.ensureOwner(ACCESS_TOKEN, OWNER_B)).resolves.toBe('linked');

    expect(line.userMenuCalls).toEqual([OWNER_A, OWNER_B]);
    expect(line.linkCalls).toEqual([{ lineUserId: OWNER_B, richMenuId: COMPLETED_MENU_ID }]);
  });
});

// --- 記録に載せてはならない値 --------------------------------------------------------

describe('ReportMenuGate の記録', () => {
  it('どの分岐でも、渡された LINE ユーザー ID を記録に載せない', async () => {
    const { gate, log } = gateWith({
      actions: async () => null,
      userMenu: async (lineUserId) =>
        lineUserId === OWNER_A ? { kind: 'lookup_failed', httpStatus: 500 } : { kind: 'not_linked' },
      link: async () => true,
    });

    await gate.checkReady(ACCESS_TOKEN);
    await gate.ensureOwner(ACCESS_TOKEN, OWNER_A);
    await gate.ensureOwner(ACCESS_TOKEN, OWNER_B);

    // 記録を出す 3 分岐すべてを通したうえで、記録の全文に識別子が 1 文字も現れないことを求める
    // （途中で分岐が減ると空振りするので、事象の並びも同時に固定する）。
    expect(eventsOf(log.entries)).toEqual([
      'delivery-job.report_menu_not_ready',
      'delivery-job.richmenu_link_failed',
      'delivery-job.richmenu_linked',
    ]);
    const serialized = JSON.stringify(log.entries);
    expect(serialized).not.toContain(OWNER_A);
    expect(serialized).not.toContain(OWNER_B);
  });
});

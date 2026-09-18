// 完了後メニューの張り替えスクリプトの試験（design.md「RichMenuDefinitions と RichMenuScripts」の
// スクリプトの契約・Requirements 2.8, 9.5）。
//
// 偽の LINE と偽の DB で 4 分類（張れた・到達不能・不一致・判定不能）を作り、分類と、
// 「不一致か判定不能が 1 件でもあれば旧メニューを削除しない」「到達不能だけなら削除する」
// 「張り替え先が 3 導線を持たなければ誰にも張らない」を固定する。
// 実 LINE・実 DB には一切つながない。

import { describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@fwlm/db';
import { buildCompletedRichMenu } from '../../scripts/rich-menu-definitions.js';
import {
  parseRelinkArgs,
  relinkCompletedMenu,
  type RelinkSummary,
} from '../../scripts/relink-completed-menu.js';

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const LIFF_STORE_DETAIL_URL = 'https://liff.line.me/2000000000-c9detail';

const NEW_MENU_ID = 'richmenu-new-0000000000000000000000';
const OLD_MENU_ID = 'richmenu-old-0000000000000000000000';

/** 試験用の LINE ユーザー ID（U + 32 文字）。先頭 8 文字が互いに異なり、9 文字目は 'a' である。 */
function fakeUserId(digit: string): string {
  return `U${digit.repeat(7)}${'a'.repeat(25)}`;
}

const USER_VERIFIED = fakeUserId('1');
const USER_UNREACHABLE = fakeUserId('2');
const USER_MISMATCH = fakeUserId('3');
const USER_ERROR = fakeUserId('4');

/** 各ユーザーの偽の LINE の応答（照会とプロフィール）。 */
interface UserScript {
  /** `GET /v2/bot/user/{userId}/richmenu` の応答。 */
  readonly lookup: { readonly status: number; readonly richMenuId?: string };
  /** `GET /v2/bot/profile/{userId}` の応答。 */
  readonly profile: { readonly status: number };
}

const DEFAULT_SCRIPTS: Readonly<Record<string, UserScript>> = {
  // 張れた: 照会が新しい ID を返す。
  [USER_VERIFIED]: { lookup: { status: 200, richMenuId: NEW_MENU_ID }, profile: { status: 200 } },
  // 到達不能: 照会は旧 ID のまま・プロフィールが 404（ブロック中・友だち解除・退会済み）。
  [USER_UNREACHABLE]: { lookup: { status: 200, richMenuId: OLD_MENU_ID }, profile: { status: 404 } },
  // 不一致: 照会は旧 ID のまま・プロフィールは取れる（友だちなのに張れていない）。
  [USER_MISMATCH]: { lookup: { status: 200, richMenuId: OLD_MENU_ID }, profile: { status: 200 } },
  // 判定不能: 照会が 5xx。
  [USER_ERROR]: { lookup: { status: 500 }, profile: { status: 200 } },
};

interface FakeLine {
  readonly fetchMock: ReturnType<typeof vi.fn>;
  readonly linkedUsers: string[];
  readonly deletedMenus: string[];
}

interface FakeLineOptions {
  /** 張り替え先のメニューの区画の action。既定は完了後メニューの 5 区画。 */
  readonly targetMenuAreas?: ReadonlyArray<{ bounds: unknown; action: unknown }>;
  readonly scripts?: Readonly<Record<string, UserScript>>;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function createFakeLine(options: FakeLineOptions = {}): FakeLine {
  const scripts = options.scripts ?? DEFAULT_SCRIPTS;
  const targetMenu = buildCompletedRichMenu(LIFF_STORE_DETAIL_URL);
  const areas = options.targetMenuAreas ?? targetMenu.areas;
  const linkedUsers: string[] = [];
  const deletedMenus: string[] = [];

  const fetchMock = vi.fn(async (rawUrl: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(rawUrl);
    const method = init?.method ?? 'GET';

    if (url === TOKEN_URL) {
      return jsonResponse(200, { access_token: 'stateless-token-1', expires_in: 900 });
    }

    // メニューそのものの照会と削除（`/v2/bot/richmenu/{richMenuId}`）。
    const menuMatch = /^https:\/\/api\.line\.me\/v2\/bot\/richmenu\/([^/]+)$/.exec(url);
    if (menuMatch) {
      const richMenuId = decodeURIComponent(menuMatch[1]!);
      if (method === 'DELETE') {
        deletedMenus.push(richMenuId);
        return jsonResponse(200, {});
      }
      if (richMenuId !== NEW_MENU_ID) {
        return jsonResponse(404, {});
      }
      return jsonResponse(200, {
        richMenuId,
        size: targetMenu.size,
        selected: targetMenu.selected,
        chatBarText: targetMenu.chatBarText,
        areas,
      });
    }

    // オーナーへのリンク（`POST /v2/bot/user/{userId}/richmenu/{richMenuId}`）。
    const linkMatch = /^https:\/\/api\.line\.me\/v2\/bot\/user\/([^/]+)\/richmenu\/([^/]+)$/.exec(url);
    if (linkMatch && method === 'POST') {
      linkedUsers.push(decodeURIComponent(linkMatch[1]!));
      return jsonResponse(200, {});
    }

    // オーナーのメニューの照会（`GET /v2/bot/user/{userId}/richmenu`）。
    const lookupMatch = /^https:\/\/api\.line\.me\/v2\/bot\/user\/([^/]+)\/richmenu$/.exec(url);
    if (lookupMatch && method === 'GET') {
      const script = scripts[decodeURIComponent(lookupMatch[1]!)];
      if (script === undefined) throw new Error(`unexpected user: ${url}`);
      return jsonResponse(
        script.lookup.status,
        script.lookup.richMenuId === undefined ? {} : { richMenuId: script.lookup.richMenuId },
      );
    }

    // プロフィールの照会（`GET /v2/bot/profile/{userId}`）。
    const profileMatch = /^https:\/\/api\.line\.me\/v2\/bot\/profile\/([^/]+)$/.exec(url);
    if (profileMatch && method === 'GET') {
      const script = scripts[decodeURIComponent(profileMatch[1]!)];
      if (script === undefined) throw new Error(`unexpected user: ${url}`);
      return jsonResponse(script.profile.status, script.profile.status === 200 ? { userId: 'x' } : {});
    }

    throw new Error(`unexpected fetch call: ${method} ${url}`);
  });

  return { fetchMock, linkedUsers, deletedMenus };
}

function createFakeDb(lineUserIds: readonly string[]): Queryable {
  return {
    query: vi.fn(async () => ({ rows: lineUserIds.map((line_user_id) => ({ line_user_id })) })),
  } as unknown as Queryable;
}

const ALL_USERS = [USER_VERIFIED, USER_UNREACHABLE, USER_MISMATCH, USER_ERROR];

async function run(
  options: {
    readonly users?: readonly string[];
    readonly deleteOld?: string | null;
    readonly dryRun?: boolean;
    readonly line?: FakeLine;
  } = {},
): Promise<{ summary: RelinkSummary; output: string; line: FakeLine }> {
  const line = options.line ?? createFakeLine();
  const lines: string[] = [];
  const summary = await relinkCompletedMenu(
    {
      channelId: 'test-channel-id',
      channelSecret: 'test-channel-secret',
      fetch: line.fetchMock as unknown as typeof fetch,
      db: createFakeDb(options.users ?? ALL_USERS),
      log: (text: string) => lines.push(text),
    },
    {
      toRichMenuId: NEW_MENU_ID,
      deleteOldRichMenuId: options.deleteOld ?? null,
      dryRun: options.dryRun ?? false,
    },
  );
  return { summary, output: lines.join('\n'), line };
}

describe('relinkCompletedMenu', () => {
  it('オーナーを 4 分類に分け、件数と先頭 8 文字を出す', async () => {
    const { summary, output, line } = await run();

    expect(summary.ready).toBe(true);
    expect(summary.targets).toBe(4);
    expect(summary.verified).toBe(1);
    expect(summary.unreachableUserPrefixes).toEqual([USER_UNREACHABLE.slice(0, 8)]);
    expect(summary.mismatchUserPrefixes).toEqual([USER_MISMATCH.slice(0, 8)]);
    expect(summary.errorUserPrefixes).toEqual([USER_ERROR.slice(0, 8)]);

    // 全員に張りにいく（到達不能かどうかは張ってからでないと判らない）。
    expect(line.linkedUsers).toEqual(ALL_USERS);

    // 一覧に出すのは確認できなかった 3 分類だけである（張れたオーナーは件数で足りる）。
    for (const user of [USER_UNREACHABLE, USER_MISMATCH, USER_ERROR]) {
      expect(output).toContain(user.slice(0, 8));
    }
    expect(output).not.toContain(USER_VERIFIED.slice(0, 8));
    expect(output).toContain('対象のオーナー: 4 件');
    expect(output).toContain('張れた: 1 件');
  });

  it('記録に LINE ユーザー ID の全体を出さない（先頭 8 文字だけ）', async () => {
    const { summary, output } = await run();

    for (const user of ALL_USERS) {
      expect(output).not.toContain(user);
      // 9 文字目まで出ていないこと（先頭 8 文字で止まっていることの証拠）。
      expect(output).not.toContain(user.slice(0, 9));
    }
    // 戻り値にも全体は入らない。
    expect(JSON.stringify(summary)).not.toContain(USER_MISMATCH.slice(0, 9));
  });

  it('不一致が 1 件でもあれば旧メニューを削除しない', async () => {
    const { summary, line } = await run({
      users: [USER_VERIFIED, USER_UNREACHABLE, USER_MISMATCH],
      deleteOld: OLD_MENU_ID,
    });

    expect(summary.mismatchUserPrefixes).toHaveLength(1);
    expect(summary.oldMenuDeleted).toBe(false);
    expect(line.deletedMenus).toEqual([]);
    expect(summary.exitCode).not.toBe(0);
  });

  it('判定不能が 1 件でもあれば旧メニューを削除しない', async () => {
    const { summary, line } = await run({
      users: [USER_VERIFIED, USER_UNREACHABLE, USER_ERROR],
      deleteOld: OLD_MENU_ID,
    });

    expect(summary.errorUserPrefixes).toHaveLength(1);
    expect(summary.oldMenuDeleted).toBe(false);
    expect(line.deletedMenus).toEqual([]);
    expect(summary.exitCode).not.toBe(0);
  });

  it('到達不能だけなら旧メニューを削除する', async () => {
    const { summary, line } = await run({
      users: [USER_VERIFIED, USER_UNREACHABLE],
      deleteOld: OLD_MENU_ID,
    });

    expect(summary.verified).toBe(1);
    expect(summary.unreachableUserPrefixes).toEqual([USER_UNREACHABLE.slice(0, 8)]);
    expect(summary.mismatchUserPrefixes).toEqual([]);
    expect(summary.errorUserPrefixes).toEqual([]);
    expect(summary.oldMenuDeleted).toBe(true);
    expect(line.deletedMenus).toEqual([OLD_MENU_ID]);
    expect(summary.exitCode).toBe(0);
  });

  it('--delete-old を渡さなければ、全員が張れても削除しない', async () => {
    const { summary, line } = await run({ users: [USER_VERIFIED] });

    expect(summary.verified).toBe(1);
    expect(summary.oldMenuDeleted).toBe(false);
    expect(line.deletedMenus).toEqual([]);
    expect(summary.exitCode).toBe(0);
  });

  it('張り替え先がレポート 3 導線を持たなければ、誰にも張らずに非ゼロで終わる', async () => {
    const completed = buildCompletedRichMenu(LIFF_STORE_DETAIL_URL);
    // 上段左（新着口コミ）の区画を落とした面。残る 2 つのレポート導線は生きている。
    const line = createFakeLine({ targetMenuAreas: completed.areas.slice(1) });

    const { summary, line: used } = await run({ deleteOld: OLD_MENU_ID, line });

    expect(summary.ready).toBe(false);
    expect(used.linkedUsers).toEqual([]);
    expect(used.deletedMenus).toEqual([]);
    expect(summary.targets).toBe(0);
    expect(summary.exitCode).not.toBe(0);
  });

  it('張り替え先を照会できなければ、誰にも張らずに非ゼロで終わる', async () => {
    // 偽の LINE は NEW_MENU_ID 以外の照会に 404 を返す。
    const line = createFakeLine();
    const summary = await relinkCompletedMenu(
      {
        channelId: 'id',
        channelSecret: 'secret',
        fetch: line.fetchMock as unknown as typeof fetch,
        db: createFakeDb(ALL_USERS),
        log: () => undefined,
      },
      { toRichMenuId: 'richmenu-unknown', deleteOldRichMenuId: OLD_MENU_ID, dryRun: false },
    );

    expect(summary.ready).toBe(false);
    expect(line.linkedUsers).toEqual([]);
    expect(line.deletedMenus).toEqual([]);
    expect(summary.exitCode).not.toBe(0);
  });

  it('--dry-run は書き込みを一切行わない', async () => {
    const { summary, line, output } = await run({ deleteOld: OLD_MENU_ID, dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.ready).toBe(true);
    expect(summary.targets).toBe(4);
    expect(line.linkedUsers).toEqual([]);
    expect(line.deletedMenus).toEqual([]);
    expect(summary.oldMenuDeleted).toBe(false);
    expect(summary.exitCode).toBe(0);
    expect(output).toContain('--dry-run');

    // 書き込みの HTTP メソッドを 1 度も使っていないこと。
    const methods = line.fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit | undefined;
      return `${init?.method ?? 'GET'} ${String(call[0])}`;
    });
    expect(methods.filter((entry) => entry.startsWith('DELETE'))).toEqual([]);
    expect(
      methods.filter((entry) => entry.startsWith('POST') && !entry.includes('oauth2/v3/token')),
    ).toEqual([]);
  });
});

describe('parseRelinkArgs', () => {
  it('--to・--delete-old・--dry-run を読む', () => {
    expect(parseRelinkArgs(['--to', NEW_MENU_ID])).toEqual({
      toRichMenuId: NEW_MENU_ID,
      deleteOldRichMenuId: null,
      dryRun: false,
    });
    expect(
      parseRelinkArgs(['--to', NEW_MENU_ID, '--delete-old', OLD_MENU_ID, '--dry-run']),
    ).toEqual({
      toRichMenuId: NEW_MENU_ID,
      deleteOldRichMenuId: OLD_MENU_ID,
      dryRun: true,
    });
  });

  it('--to が無い・値が欠けている・知らない引数は例外にする', () => {
    expect(() => parseRelinkArgs([])).toThrow(/--to/);
    expect(() => parseRelinkArgs(['--to'])).toThrow(/--to/);
    expect(() => parseRelinkArgs(['--to', NEW_MENU_ID, '--delete-old'])).toThrow(/--delete-old/);
    expect(() => parseRelinkArgs(['--to', NEW_MENU_ID, '--force'])).toThrow(/--force/);
  });
});

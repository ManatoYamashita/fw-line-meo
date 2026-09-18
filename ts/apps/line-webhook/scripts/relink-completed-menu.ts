// 完了後メニューの張り替えスクリプト（design.md「RichMenuDefinitions と RichMenuScripts」の
// スクリプトの契約・Requirements 2.8, 9.5）。
//
// メニューは作った後で区画も画像も差し替えられないため、内容を変えるときは新しいメニューを作って
// 全員を張り替えることになる（references/rich-menu.md「Cannot replace an image once uploaded」）。
// 本スクリプトは、その張り替えと、結果の確認と、確認できたときに限った旧メニューの削除を行う。
//
// 手順（design.md のスクリプトの契約）:
//   1. `--to` のメニューがレポート 3 導線を持つことを確かめる（`exposesAllReportActions`）。
//      満たさなければ **誰にも張らずに** 非ゼロで終わる。押しても答えの返らない面を配らないため
//   2. `owners.onboarding_status = 'store_identified'` の LINE ユーザーを読む
//   3. 各オーナーへ個別リンクを張り、照会とプロフィールの照会で 4 つに分ける
//   4. 分類ごとの件数と、到達不能・不一致・判定不能のユーザーの先頭 8 文字を出す
//   5. `--delete-old` があり、不一致と判定不能が 0 件のときに限り旧メニューを削除する
//
// 4 分類の根拠: LINE はブロック中・友だち解除・退会済みのユーザーへのリンクを 200 で受理して黙って
// 失敗する（references/rich-menu.md「Link conditions」）。したがって「張った」ことは成功の証拠に
// ならず、照会（`GET /v2/bot/user/{userId}/richmenu`）で確かめる必要がある。新しい ID が返らなかった
// ときに、届かない相手なのか（到達不能）・友だちなのに張れていないのか（不一致）を見分けるのが
// プロフィールの照会（`GET /v2/bot/profile/{userId}`。ブロック中の相手は取得できない）である。
//
// 記録（ログ）に LINE ユーザー ID の全体を出さない。分類の一覧に載せるのは先頭 8 文字だけで、
// 戻り値にも全体を持たない（運用記録へ貼られても識別子が漏れない形にしておく）。
//
// 運用者が手で実行するワンショットスクリプトである（`--dry-run` で何も書かずに対象を数えられる）。
// line-webhook サーバ本体（app.ts/index.ts）の実行経路には一切配線しない。
//
// LINE API contracts（.claude/skills/messaging-api/references/）:
//   - rich-menu.md「Rich Menu CRUD」: 照会 `GET /v2/bot/richmenu/{richMenuId}`、
//     削除 `DELETE /v2/bot/richmenu/{richMenuId}`（100 req/hr）
//   - rich-menu.md「Per-user Rich Menu」: リンク `POST /v2/bot/user/{userId}/richmenu/{richMenuId}`、
//     オーナーのメニューの照会 `GET /v2/bot/user/{userId}/richmenu`
//   - user.md「Get User Profile」: `GET /v2/bot/profile/{userId}`（ブロック中の相手は取得できない）
//   - channel-token.md「Stateless Channel Access Token」: `POST https://api.line.me/oauth2/v3/token`
//
// トークンの発行はこのスクリプト自身が持つ（setup-rich-menus.ts の非公開関数を import しない。
// 既存のスクリプトと同じく素朴に再実装する）。

import { fileURLToPath } from 'node:url';
import type { Queryable } from '@fwlm/db';
import { createPool } from '@fwlm/db';
import { exposesAllReportActions, type RichMenuActionLike } from '@fwlm/line-report';

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const API_BASE_URL = 'https://api.line.me';

/** 1 リクエストあたりの許容時間。超過は「判定できなかった」として扱う。 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 記録に出す LINE ユーザー ID の文字数。識別子の全体は出さない。 */
const USER_ID_PREFIX_LENGTH = 8;

export type RelinkOutcome = 'verified' | 'unreachable' | 'mismatch' | 'error';

export interface RelinkOptions {
  /** 張り替え先（新しい完了後メニュー）の richMenuId。 */
  readonly toRichMenuId: string;
  /** 確認できたときに削除する旧メニューの richMenuId。渡さなければ削除しない。 */
  readonly deleteOldRichMenuId: string | null;
  /** true なら LINE へ書き込む操作（リンク・削除）を一切行わない。 */
  readonly dryRun: boolean;
}

export interface RelinkDeps {
  readonly channelId: string;
  readonly channelSecret: string;
  // グローバル fetch を直接使わず注入する（setup-rich-menus.ts と同じテスト容易性の規律）。
  readonly fetch: typeof fetch;
  readonly db: Queryable;
  readonly log?: (line: string) => void;
}

export interface RelinkSummary {
  /** 張り替え先がレポート 3 導線を持つことを確かめられたか。false のときは誰にも張っていない。 */
  readonly ready: boolean;
  readonly dryRun: boolean;
  /** 店舗特定済みオーナーの数。 */
  readonly targets: number;
  /** 照会で新しい ID を確かめられた数。 */
  readonly verified: number;
  /** 到達不能（プロフィールが 404）のユーザーの先頭 8 文字。 */
  readonly unreachableUserPrefixes: readonly string[];
  /** 不一致（友だちなのに張れていない）のユーザーの先頭 8 文字。 */
  readonly mismatchUserPrefixes: readonly string[];
  /** 判定不能（ネットワーク・5xx）のユーザーの先頭 8 文字。 */
  readonly errorUserPrefixes: readonly string[];
  readonly oldMenuDeleted: boolean;
  /** プロセスの終了コード。0 以外は運用者の対応が要ることを表す。 */
  readonly exitCode: number;
}

interface StoreIdentifiedOwnerRow {
  readonly line_user_id: string | null;
}

/** LINE への 1 回の呼出の結果。transport はネットワーク断・タイムアウト（応答を得られなかった）。 */
type LineCallOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly body: string }
  | { readonly kind: 'transport' };

interface RawTokenResponse {
  access_token?: unknown;
}

// --- LINE への呼出 ------------------------------------------------------------------

async function issueAccessToken(deps: RelinkDeps): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: deps.channelId,
    client_secret: deps.channelSecret,
  });

  const response = await deps.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`relinkCompletedMenu: failed to issue channel access token (status ${response.status})`);
  }

  const parsed = (await response.json()) as RawTokenResponse;
  if (typeof parsed.access_token !== 'string') {
    throw new Error('relinkCompletedMenu: unexpected token issuance response shape');
  }
  return parsed.access_token;
}

/**
 * LINE を 1 回だけ呼ぶ。再送しない（張り替えは運用者が見ている前で一度に流す作業であり、
 * 判定できなかった相手は分類として残してやり直す方が、黙って待たせるより扱いやすい）。
 */
async function callLine(
  deps: RelinkDeps,
  accessToken: string,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
): Promise<LineCallOutcome> {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // ネットワーク断・タイムアウトは「応答を得られなかった」という観測可能な結果へ変換する。
    // 呼出元が判定不能として分類し、件数と先頭 8 文字を運用者へ出す（握り潰さない）。
    return { kind: 'transport' };
  }
  return { kind: 'response', status: response.status, body: await response.text() };
}

function parseJsonObject(rawBody: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // 壊れた本文は「読めなかった」として null にする。呼出元が判定不能・未確認として扱う。
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** メニューの応答（RichMenuResponse）から、判定に要る項目だけの action を取り出す。 */
function parseRichMenuActions(rawBody: string): RichMenuActionLike[] | null {
  const parsed = parseJsonObject(rawBody);
  if (parsed === null || !Array.isArray(parsed['areas'])) {
    return null;
  }
  const actions: RichMenuActionLike[] = [];
  for (const area of parsed['areas']) {
    if (typeof area !== 'object' || area === null) continue;
    const action: unknown = (area as Record<string, unknown>)['action'];
    if (typeof action !== 'object' || action === null) continue;
    const type: unknown = (action as Record<string, unknown>)['type'];
    if (typeof type !== 'string') continue;
    const data: unknown = (action as Record<string, unknown>)['data'];
    actions.push(typeof data === 'string' ? { type, data } : { type });
  }
  return actions;
}

// --- 分類 --------------------------------------------------------------------------

/**
 * オーナー 1 人を張り替えて分類する。
 *
 * 応答を得られなかった呼出と 5xx は、そのまま判定不能にする（「張れていない」と断じない）。
 * 新しい ID を確かめられなかったときだけプロフィールを照会し、到達不能と不一致を見分ける。
 */
async function relinkOwner(
  deps: RelinkDeps,
  accessToken: string,
  lineUserId: string,
  toRichMenuId: string,
): Promise<RelinkOutcome> {
  const encodedUser = encodeURIComponent(lineUserId);

  const link = await callLine(
    deps,
    accessToken,
    'POST',
    `${API_BASE_URL}/v2/bot/user/${encodedUser}/richmenu/${encodeURIComponent(toRichMenuId)}`,
  );
  if (link.kind === 'transport' || link.status >= 500) {
    return 'error';
  }

  if (link.status >= 200 && link.status < 300) {
    const lookup = await callLine(deps, accessToken, 'GET', `${API_BASE_URL}/v2/bot/user/${encodedUser}/richmenu`);
    if (lookup.kind === 'transport' || lookup.status >= 500) {
      return 'error';
    }
    if (lookup.status === 200) {
      const parsed = parseJsonObject(lookup.body);
      const richMenuId: unknown = parsed === null ? undefined : parsed['richMenuId'];
      if (richMenuId === toRichMenuId) {
        return 'verified';
      }
    }
  }

  const profile = await callLine(deps, accessToken, 'GET', `${API_BASE_URL}/v2/bot/profile/${encodedUser}`);
  if (profile.kind === 'transport' || profile.status >= 500) {
    return 'error';
  }
  if (profile.status === 404) {
    // ブロック中・友だち解除・退会済み。メニューを表示しようがない相手である。
    return 'unreachable';
  }
  if (profile.status === 200) {
    return 'mismatch';
  }
  return 'error';
}

// --- 対象の読み出し -----------------------------------------------------------------

/**
 * 店舗特定済みオーナーの LINE ユーザーを読む（読み出しのみ。この経路は DB へ書かない）。
 * 並びを固定するのは、途中で止まったときに同じ順で流し直せるようにするためである。
 */
async function listStoreIdentifiedLineUserIds(db: Queryable): Promise<string[]> {
  const result = await db.query<StoreIdentifiedOwnerRow>(
    `SELECT line_user_id FROM owners WHERE onboarding_status = 'store_identified' ORDER BY created_at, id`,
  );
  const lineUserIds: string[] = [];
  for (const row of result.rows) {
    if (typeof row.line_user_id === 'string' && row.line_user_id.length > 0) {
      lineUserIds.push(row.line_user_id);
    }
  }
  return lineUserIds;
}

function prefixOf(lineUserId: string): string {
  return lineUserId.slice(0, USER_ID_PREFIX_LENGTH);
}

// --- 本体 --------------------------------------------------------------------------

export async function relinkCompletedMenu(
  deps: RelinkDeps,
  options: RelinkOptions,
): Promise<RelinkSummary> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const accessToken = await issueAccessToken(deps);

  const notReady: RelinkSummary = {
    ready: false,
    dryRun: options.dryRun,
    targets: 0,
    verified: 0,
    unreachableUserPrefixes: [],
    mismatchUserPrefixes: [],
    errorUserPrefixes: [],
    oldMenuDeleted: false,
    exitCode: 1,
  };

  // 手順 1: 張り替え先がレポート 3 導線を持つことを、誰かに張る前に確かめる。
  const target = await callLine(
    deps,
    accessToken,
    'GET',
    `${API_BASE_URL}/v2/bot/richmenu/${encodeURIComponent(options.toRichMenuId)}`,
  );
  if (target.kind === 'transport' || target.status !== 200) {
    log(`張り替え先のメニューを照会できませんでした（${target.kind === 'transport' ? '応答なし' : `status ${target.status}`}）。何もしていません。`);
    return notReady;
  }
  const actions = parseRichMenuActions(target.body);
  if (actions === null || !exposesAllReportActions(actions)) {
    log('張り替え先のメニューにレポートの 3 導線がそろっていません。何もしていません。');
    return notReady;
  }
  log(`張り替え先: ${options.toRichMenuId}（レポート 3 導線を確認しました）`);

  // 手順 2: 対象のオーナーを読む。
  const lineUserIds = await listStoreIdentifiedLineUserIds(deps.db);
  log(`対象のオーナー: ${lineUserIds.length} 件`);

  if (options.dryRun) {
    log('--dry-run のため、リンクと削除は行いません。');
    if (options.deleteOldRichMenuId !== null) {
      log(`削除の候補: ${options.deleteOldRichMenuId}（確認が全員分そろった実行でのみ削除します）`);
    }
    return {
      ready: true,
      dryRun: true,
      targets: lineUserIds.length,
      verified: 0,
      unreachableUserPrefixes: [],
      mismatchUserPrefixes: [],
      errorUserPrefixes: [],
      oldMenuDeleted: false,
      exitCode: 0,
    };
  }

  // 手順 3: 張って、分類する。
  let verified = 0;
  const unreachable: string[] = [];
  const mismatch: string[] = [];
  const failed: string[] = [];

  for (const lineUserId of lineUserIds) {
    const outcome = await relinkOwner(deps, accessToken, lineUserId, options.toRichMenuId);
    if (outcome === 'verified') {
      verified += 1;
    } else if (outcome === 'unreachable') {
      unreachable.push(prefixOf(lineUserId));
    } else if (outcome === 'mismatch') {
      mismatch.push(prefixOf(lineUserId));
    } else {
      failed.push(prefixOf(lineUserId));
    }
  }

  // 手順 4: 件数と、確認できなかったユーザーの先頭 8 文字を出す。
  log(`張れた: ${verified} 件`);
  log(`到達不能: ${unreachable.length} 件`);
  log(`不一致: ${mismatch.length} 件`);
  log(`判定不能: ${failed.length} 件`);
  if (unreachable.length > 0) log(`到達不能のユーザー（先頭 8 文字）: ${unreachable.join(' ')}`);
  if (mismatch.length > 0) log(`不一致のユーザー（先頭 8 文字）: ${mismatch.join(' ')}`);
  if (failed.length > 0) log(`判定不能のユーザー（先頭 8 文字）: ${failed.join(' ')}`);

  // 手順 5: 全員が「張れた」か「到達不能」に確定したときに限り、旧メニューを削除する（Requirement 9.5）。
  const confirmed = mismatch.length === 0 && failed.length === 0;
  let oldMenuDeleted = false;

  if (options.deleteOldRichMenuId !== null) {
    if (!confirmed) {
      log(`旧メニュー ${options.deleteOldRichMenuId} は削除しません（不一致 ${mismatch.length} 件・判定不能 ${failed.length} 件）。原因を調べて流し直してください。`);
    } else {
      const deletion = await callLine(
        deps,
        accessToken,
        'DELETE',
        `${API_BASE_URL}/v2/bot/richmenu/${encodeURIComponent(options.deleteOldRichMenuId)}`,
      );
      if (deletion.kind === 'response' && deletion.status >= 200 && deletion.status < 300) {
        oldMenuDeleted = true;
        log(`旧メニュー ${options.deleteOldRichMenuId} を削除しました。`);
      } else {
        log(`旧メニュー ${options.deleteOldRichMenuId} の削除に失敗しました（${deletion.kind === 'transport' ? '応答なし' : `status ${deletion.status}`}）。`);
      }
    }
  } else if (confirmed) {
    log('旧メニューの削除は指定されていません（--delete-old を渡すと削除します）。');
  }

  // 削除を指定していなくても、確認できなかったオーナーが残る実行は非ゼロで終わる（流し直しが要る）。
  const exitCode =
    confirmed && (options.deleteOldRichMenuId === null || oldMenuDeleted) ? 0 : 1;

  return {
    ready: true,
    dryRun: false,
    targets: lineUserIds.length,
    verified,
    unreachableUserPrefixes: unreachable,
    mismatchUserPrefixes: mismatch,
    errorUserPrefixes: failed,
    oldMenuDeleted,
    exitCode,
  };
}

// --- CLI ---------------------------------------------------------------------------

/**
 * 引数を読む（`--to <新ID> [--delete-old <旧ID>] [--dry-run]`）。
 * 知らない引数と値の欠けは例外にする（打ち間違いのまま全員へ張るより、止まる方が安全である）。
 */
export function parseRelinkArgs(argv: readonly string[]): RelinkOptions {
  let toRichMenuId: string | null = null;
  let deleteOldRichMenuId: string | null = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--to' || arg === '--delete-old') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`relink-completed-menu: ${arg} requires a richMenuId`);
      }
      if (arg === '--to') {
        toRichMenuId = value;
      } else {
        deleteOldRichMenuId = value;
      }
      index += 1;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    throw new Error(`relink-completed-menu: unknown argument ${String(arg)}`);
  }

  if (toRichMenuId === null) {
    throw new Error('relink-completed-menu: --to <richMenuId> is required');
  }
  return { toRichMenuId, deleteOldRichMenuId, dryRun };
}

// CLI エントリポイント（運用者が手で実行する）。
// 実行方法（ts/apps/line-webhook をカレントディレクトリとして）:
//   pnpm run build:scripts
//   LINE_CHANNEL_ID=... LINE_CHANNEL_SECRET=... DATABASE_URL=... \
//     pnpm run relink-completed-menu --to <新ID> [--delete-old <旧ID>] [--dry-run]
// 引数の前に `--` を挟まないこと。pnpm 10 は `--` を区切りとして食わずそのまま argv へ渡すため、
// 上の parseRelinkArgs が `unknown argument --` で落ちる（実測）。運用手順は infra/README.md §10。
const isMainModule = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  void (async () => {
    const channelId = process.env.LINE_CHANNEL_ID;
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    if (!channelId) {
      throw new Error('LINE_CHANNEL_ID is required');
    }
    if (!channelSecret) {
      throw new Error('LINE_CHANNEL_SECRET is required');
    }
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required');
    }

    const options = parseRelinkArgs(process.argv.slice(2));
    const handle = await createPool(process.env);
    try {
      const summary = await relinkCompletedMenu(
        { channelId, channelSecret, fetch, db: handle.pool },
        options,
      );
      process.exitCode = summary.exitCode;
    } finally {
      await handle.close();
    }
  })().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

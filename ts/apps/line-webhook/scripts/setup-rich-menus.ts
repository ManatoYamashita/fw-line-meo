// リッチメニュー運用セットアップスクリプト（design.md「RichMenuSetupScript」, Batch）。
//
// Requirement 6.1: 友だち追加後のオーナー全員に、オンボーディング再開の導線を含む常設メニューを
//   表示する（= デフォルトリッチメニューとして「オンボーディング用」メニューを設定する）。
// Requirement 6.2: 常設メニューからの再開操作（タップ）に対し、進捗に応じた案内を返す。
//   本スクリプトはタップ領域に resume postback（`encodePostback({ kind: 'resume' })`）を
//   割り当てる配線のみを担う。実際の「進捗に応じた案内」自体は ConversationHandlers
//   （タスク 3.4 で実装済みの postback ハンドラ）が担当する。
// Requirement 6.3（前提）: 店舗特定済みへの遷移時、常設メニューを完了後の案内に切り替える。
//   実際の個別リンク（linkRichMenu）は ConversationHandlers が confirmStore 完了時に
//   LINE_RICHMENU_COMPLETED_ID を用いて行う（タスク 3.4/4.2 で配線済み）。
//   本スクリプトは「完了後」メニューを作成し、その richMenuId を出力するところまでを担う
//   （運用者がその値を LINE_RICHMENU_COMPLETED_ID に設定する）。
//
// 運用者がデプロイ時に一度だけ手動実行するワンショットスクリプト（design.md 「RichMenuSetupScript」
// = Batch）。line-webhook サーバ本体（app.ts/index.ts）の実行経路には一切配線しない。
//
// LINE Rich Menu API contracts（.claude/skills/messaging-api/references/rich-menu.md,
// action-objects.md 準拠。記憶ではなくこれらの参照ドキュメントに基づく）:
//   - Create:        POST https://api.line.me/v2/bot/richmenu
//   - Upload image:  POST https://api-data.line.me/v2/bot/richmenu/{richMenuId}/content
//                    （画像アップロードのみ api.line.me ではなく api-data.line.me である点に注意）
//   - Set default:   POST https://api.line.me/v2/bot/user/all/richmenu/{richMenuId}
//   - postback action: { type: 'postback', data, label? }
//   - message action:  { type: 'message', text, label? }
//
// トークン発行は client.ts（LineMessenger）の POST https://api.line.me/oauth2/v3/token
// （client_credentials）と同一パターンだが、client.ts はキャッシュ用の private closure に
// 閉じ込められており本スクリプトからは再利用できない（かつ client.ts は本タスクの変更禁止対象）。
// 本スクリプトは一度きりの実行で複数回のキャッシュ再利用も不要なため、素朴に再実装する。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { encodePostback } from '../src/onboarding/stages.js';

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const CREATE_RICHMENU_URL = 'https://api.line.me/v2/bot/richmenu';
const UPLOAD_IMAGE_URL_BASE = 'https://api-data.line.me/v2/bot/richmenu';
const SET_DEFAULT_URL_BASE = 'https://api.line.me/v2/bot/user/all/richmenu';
const BATCH_URL = 'https://api.line.me/v2/bot/richmenu/batch';
const BATCH_PROGRESS_URL = 'https://api.line.me/v2/bot/richmenu/progress/batch';

// Full (Compact) 800x540（ratio 1.481 >= 1.45 要件）。最小の標準サイズを採用しファイルサイズを抑える。
const RICH_MENU_WIDTH = 800;
const RICH_MENU_HEIGHT = 540;

// 完了後メニュー（gbp task 5.2）の 2×2 グリッド分割座標。800×540 を 4 等分（各セル 400×270）し、
// 重複なく画像全面を被覆する（references/rich-menu.md: bounds は左上原点・px 指定）。
const COMPLETED_MENU_COL_WIDTH = RICH_MENU_WIDTH / 2;
const COMPLETED_MENU_ROW_HEIGHT = RICH_MENU_HEIGHT / 2;

export interface RichMenuAction {
  type: 'postback' | 'message';
  label?: string;
  data?: string;
  text?: string;
}

export interface RichMenuArea {
  bounds: { x: number; y: number; width: number; height: number };
  action: RichMenuAction;
}

export interface RichMenuObject {
  size: { width: number; height: number };
  selected: boolean;
  name: string;
  chatBarText: string;
  areas: RichMenuArea[];
}

export interface SetupRichMenusDeps {
  channelId: string;
  channelSecret: string;
  // グローバル fetch を直接使わず注入する（client.ts/places/search.ts と同じテスト容易性の規律）。
  fetch: typeof fetch;
  onboardingImage: Buffer;
  completedImage: Buffer;
}

export interface SetupRichMenusResult {
  onboardingRichMenuId: string;
  completedRichMenuId: string;
}

/** `POST /v2/bot/richmenu/progress/batch` の phase（LINE SDK の RichMenuBatchProgressPhase と同値）。 */
export type RichMenuBatchPhase = 'ongoing' | 'succeeded' | 'failed';

export interface RelinkResult {
  /** `x-line-request-id` ヘッダ。進捗照会のキー。 */
  requestId: string | null;
  phase: RichMenuBatchPhase | 'unknown';
}

/**
 * 既存の連携済みオーナーを新しい完了後メニューへ移す（PR #121 レビュー指摘の是正）。
 *
 * `linkRichMenu` は confirmStore 完了時の 1 箇所でしか呼ばれないため、完了後メニューを
 * 作り直しても **既に completed のオーナーは旧メニューに紐づいたまま**で、Req 5.4 の常設導線が
 * 届かない。GBP 機能の主対象がまさにこの層である。
 *
 * `POST /v2/bot/richmenu/batch` の link 操作（旧メニュー → 新メニュー）を使う。
 * `bulk/link`（500 件上限・userId の一覧が要る）ではなくこちらを選ぶのは、
 * **userId のリストが不要**でスクリプトに DB 依存を持ち込まずに済み、かつ「旧メニューに
 * リンクされている全ユーザー」を対象にできて取りこぼしが構造的に起きないため。
 *
 * batch は**非同期**（受理と反映は別）。レート制限は **3 req/hr** なので、失敗しても
 * 安易に叩き直さないこと。進捗は requestId で照会する。
 */
export async function relinkExistingUsers(
  deps: Pick<SetupRichMenusDeps, 'channelId' | 'channelSecret' | 'fetch'>,
  fromRichMenuId: string,
  toRichMenuId: string,
): Promise<RelinkResult> {
  const accessToken = await issueAccessToken(deps);

  const response = await deps.fetch(BATCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    // 形は @line/bot-sdk の RichMenuBatchRequest / RichMenuBatchLinkOperation に一致させている
    // （同 SDK は LINE 公開の OpenAPI から生成されたもの）。
    body: JSON.stringify({
      operations: [{ type: 'link', from: fromRichMenuId, to: toRichMenuId }],
    }),
  });

  if (!response.ok) {
    throw new Error(`relinkExistingUsers: batch failed with status ${response.status}`);
  }

  // batch の応答本文は空。進捗照会のキーは `x-line-request-id` ヘッダで返る。
  const requestId = response.headers.get('x-line-request-id');
  if (requestId === null) {
    return { requestId: null, phase: 'unknown' };
  }

  const progress = await deps.fetch(
    `${BATCH_PROGRESS_URL}?requestId=${encodeURIComponent(requestId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!progress.ok) {
    return { requestId, phase: 'unknown' };
  }

  const parsed: unknown = await progress.json();
  const phase =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { phase?: unknown }).phase
      : undefined;
  return {
    requestId,
    phase: phase === 'ongoing' || phase === 'succeeded' || phase === 'failed' ? phase : 'unknown',
  };
}

interface RawTokenResponse {
  access_token?: unknown;
}

interface RawCreateRichMenuResponse {
  richMenuId?: unknown;
}

async function issueAccessToken(
  deps: Pick<SetupRichMenusDeps, 'channelId' | 'channelSecret' | 'fetch'>,
): Promise<string> {
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
    throw new Error(`setupRichMenus: failed to issue channel access token (status ${response.status})`);
  }

  const parsed = (await response.json()) as RawTokenResponse;
  if (typeof parsed.access_token !== 'string') {
    throw new Error('setupRichMenus: unexpected token issuance response shape');
  }

  return parsed.access_token;
}

async function createRichMenu(
  deps: Pick<SetupRichMenusDeps, 'fetch'>,
  accessToken: string,
  richMenu: RichMenuObject,
): Promise<string> {
  const response = await deps.fetch(CREATE_RICHMENU_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(richMenu),
  });

  if (!response.ok) {
    throw new Error(`setupRichMenus: failed to create rich menu "${richMenu.name}" (status ${response.status})`);
  }

  const parsed = (await response.json()) as RawCreateRichMenuResponse;
  if (typeof parsed.richMenuId !== 'string') {
    throw new Error('setupRichMenus: unexpected create-richmenu response shape');
  }

  return parsed.richMenuId;
}

async function uploadRichMenuImage(
  deps: Pick<SetupRichMenusDeps, 'fetch'>,
  accessToken: string,
  richMenuId: string,
  image: Buffer,
): Promise<void> {
  const response = await deps.fetch(`${UPLOAD_IMAGE_URL_BASE}/${encodeURIComponent(richMenuId)}/content`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'image/png',
    },
    body: image,
  });

  if (!response.ok) {
    throw new Error(
      `setupRichMenus: failed to upload image for richMenuId ${richMenuId} (status ${response.status})`,
    );
  }
}

async function setDefaultRichMenu(
  deps: Pick<SetupRichMenusDeps, 'fetch'>,
  accessToken: string,
  richMenuId: string,
): Promise<void> {
  const response = await deps.fetch(`${SET_DEFAULT_URL_BASE}/${encodeURIComponent(richMenuId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`setupRichMenus: failed to set default rich menu (status ${response.status})`);
  }
}

export function buildOnboardingRichMenu(): RichMenuObject {
  return {
    size: { width: RICH_MENU_WIDTH, height: RICH_MENU_HEIGHT },
    selected: false,
    name: 'line-onboarding-resume-menu',
    chatBarText: '登録を再開',
    areas: [
      {
        bounds: { x: 0, y: 0, width: RICH_MENU_WIDTH, height: RICH_MENU_HEIGHT },
        action: {
          type: 'postback',
          label: '登録を再開する',
          data: encodePostback({ kind: 'resume' }),
        },
      },
    ],
  };
}

// 完了後（店舗特定済み）オーナー向けの常設メニュー。
//
// gbp-post-review-reply spec task 5.2 / Requirement 5.4（サマリー配信時刻に依存しない常設導線）に従い、
// design.md「RichMenu 拡張（setup-rich-menus.ts）」の指定どおり 4 領域化する:
//   ステータス確認（既存 message）/ Google 投稿作成（g_post）/ クチコミ返信（g_reply）/ Google 連携・設定（g_status）
//
// レイアウト（800×540 を 4 分割・重複なし・画像全面を被覆）:
//   ┌───────────────┬────────────────┐
//   │ ステータス確認 │ Google 投稿作成 │
//   ├───────────────┼────────────────┤
//   │ クチコミ返信   │ Google 連携・設定│
//   └───────────────┴────────────────┘
//
// postback data の整合性（重要）: 各 postback 領域の data は src/gbp/postback.ts の
//   `encodeGbpPostback` の出力と完全一致させる。g_post / g_reply / g_status は引数を持たない
//   単純 action であり、encodeGbpPostback は該当 case で `a=${action.action}` を返すため、
//     encodeGbpPostback({ action: 'g_post' })   === 'a=g_post'
//     encodeGbpPostback({ action: 'g_reply' })  === 'a=g_reply'
//     encodeGbpPostback({ action: 'g_status' }) === 'a=g_status'
//   となる（postback.ts を確認済み）。よって下記リテラルは webhook 側 `decodeGbpPostback` /
//   `isGbpPostbackData`（`g_` プレフィックス判定）で正しく受理される。
//   postback.ts をここから import せずリテラルにするのは、ワンショット script のコンパイル対象
//   （tsconfig.scripts.json）へ src/gbp を引き込まないため。整合は test/scripts の dry-run で
//   `decodeGbpPostback` により機械検証している。
export function buildCompletedRichMenu(): RichMenuObject {
  return {
    size: { width: RICH_MENU_WIDTH, height: RICH_MENU_HEIGHT },
    selected: false,
    name: 'line-onboarding-completed-menu',
    chatBarText: 'メニュー',
    areas: [
      {
        // 左上: ステータス確認。**message アクションにしてはならない**（PR #121 レビュー指摘）。
        //
        // message はタップ時にテキストを送信する。同 PR が completed 段階のテキストを GBP の
        // 入力チャネルにしたため、投稿フローの await_input 中にこれを押すと文字列
        // 「ステータス確認」が **投稿の要点として取り込まれ**、承認ボタン付きの下書きが提示される
        // （handlePostInput の除外は trim().length === 0 のみ）。await_revision 中は修正指示として
        // 解釈され、connect/await_callback 中（最大 30 分）は GBP の状態案内に吸われる。
        //
        // `a=resume` は `g_` プレフィックスを持たないので isGbpPostbackData が false になり、
        // conversation.ts の completed 分岐が buildAlreadyCompletedMessage() を返す。
        // これは message アクション時代の最終的な応答と同一で、テキスト注入経路だけが消える。
        bounds: { x: 0, y: 0, width: COMPLETED_MENU_COL_WIDTH, height: COMPLETED_MENU_ROW_HEIGHT },
        action: {
          type: 'postback',
          label: 'ステータス確認',
          data: encodePostback({ kind: 'resume' }),
        },
      },
      {
        // 右上: Google 投稿作成。data === encodeGbpPostback({ action: 'g_post' })。
        bounds: {
          x: COMPLETED_MENU_COL_WIDTH,
          y: 0,
          width: COMPLETED_MENU_COL_WIDTH,
          height: COMPLETED_MENU_ROW_HEIGHT,
        },
        action: {
          type: 'postback',
          label: 'Google 投稿作成',
          data: 'a=g_post',
        },
      },
      {
        // 左下: クチコミ返信。data === encodeGbpPostback({ action: 'g_reply' })。
        bounds: {
          x: 0,
          y: COMPLETED_MENU_ROW_HEIGHT,
          width: COMPLETED_MENU_COL_WIDTH,
          height: COMPLETED_MENU_ROW_HEIGHT,
        },
        action: {
          type: 'postback',
          label: 'クチコミ返信',
          data: 'a=g_reply',
        },
      },
      {
        // 右下: Google 連携・設定。data === encodeGbpPostback({ action: 'g_status' })。
        bounds: {
          x: COMPLETED_MENU_COL_WIDTH,
          y: COMPLETED_MENU_ROW_HEIGHT,
          width: COMPLETED_MENU_COL_WIDTH,
          height: COMPLETED_MENU_ROW_HEIGHT,
        },
        action: {
          type: 'postback',
          label: 'Google 連携・設定',
          data: 'a=g_status',
        },
      },
    ],
  };
}

export async function setupRichMenus(deps: SetupRichMenusDeps): Promise<SetupRichMenusResult> {
  const accessToken = await issueAccessToken(deps);

  const onboardingRichMenuId = await createRichMenu(deps, accessToken, buildOnboardingRichMenu());
  await uploadRichMenuImage(deps, accessToken, onboardingRichMenuId, deps.onboardingImage);

  const completedRichMenuId = await createRichMenu(deps, accessToken, buildCompletedRichMenu());
  await uploadRichMenuImage(deps, accessToken, completedRichMenuId, deps.completedImage);

  // Requirement 6.1: オンボーディング用メニューを全ユーザーのデフォルトに設定する。
  // 完了後メニューは per-user リンク専用（confirmStore 完了時に ConversationHandlers が
  // linkRichMenu で個別に切り替える。design.md stateDiagram 参照）であり、デフォルトにはしない。
  await setDefaultRichMenu(deps, accessToken, onboardingRichMenuId);

  return { onboardingRichMenuId, completedRichMenuId };
}

// CLI エントリポイント（運用者がデプロイ時に手動実行する）。
// 実行方法（ts/apps/line-webhook をカレントディレクトリとして）:
//   pnpm run build:scripts && LINE_CHANNEL_ID=... LINE_CHANNEL_SECRET=... pnpm run setup-rich-menus
//
// 既存オーナーを新しい完了後メニューへ移す（メニュー作成とは別に 1 回だけ実行する）:
//   ... pnpm run setup-rich-menus -- --relink-existing <旧richMenuId> <新richMenuId>
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

    const relinkAt = process.argv.indexOf('--relink-existing');
    if (relinkAt !== -1) {
      const fromId = process.argv[relinkAt + 1];
      const toId = process.argv[relinkAt + 2];
      if (fromId === undefined || toId === undefined) {
        throw new Error('--relink-existing には <旧richMenuId> <新richMenuId> の 2 つが必要です');
      }
      const result = await relinkExistingUsers({ channelId, channelSecret, fetch }, fromId, toId);
      console.log('一括再リンクを受理しました。requestId:', result.requestId ?? '(不明)');
      console.log('進捗:', result.phase);
      console.log(
        'batch は非同期です。ongoing の場合は ' +
          'GET /v2/bot/richmenu/progress/batch?requestId=... で追跡してください' +
          '（レート制限 3 req/hr のため、失敗しても安易に叩き直さないこと）。',
      );
      return;
    }

    // assets/ はカレントディレクトリ（ts/apps/line-webhook）基準で解決する
    // （dist-scripts へのコンパイル後の出力階層に依存させないため）。
    const assetsDir = path.resolve(process.cwd(), 'assets');
    const [onboardingImage, completedImage] = await Promise.all([
      readFile(path.join(assetsDir, 'richmenu-onboarding.png')),
      readFile(path.join(assetsDir, 'richmenu-completed.png')),
    ]);

    const result = await setupRichMenus({
      channelId,
      channelSecret,
      fetch,
      onboardingImage,
      completedImage,
    });

    console.log('オンボーディング用リッチメニュー richMenuId:', result.onboardingRichMenuId);
    console.log('完了用リッチメニュー richMenuId:', result.completedRichMenuId);
    console.log('LINE_RICHMENU_COMPLETED_ID には上記「完了用」の richMenuId を設定してください。');
  })().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

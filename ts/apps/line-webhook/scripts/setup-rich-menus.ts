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
// 動作は 2 つある（line-on-demand-report design.md「RichMenuDefinitions と RichMenuScripts」）。
//   - 既定（引数なし）: 2 面とも作り、オンボーディング用を既定メニューにする（初期構築）
//   - `--completed-only`: 完了後メニューだけを作って richMenuId を出す。既定メニューには触れない
//     （メニューの差し替え = Migration Strategy の Step C）
// メニューの寸法・区画・action の定義は rich-menu-definitions.ts が持つ。
//
// LINE Rich Menu API contracts（.claude/skills/messaging-api/references/rich-menu.md,
// action-objects.md 準拠。記憶ではなくこれらの参照ドキュメントに基づく）:
//   - Create:        POST https://api.line.me/v2/bot/richmenu
//   - Upload image:  POST https://api-data.line.me/v2/bot/richmenu/{richMenuId}/content
//                    （画像アップロードのみ api.line.me ではなく api-data.line.me である点に注意）
//   - Set default:   POST https://api.line.me/v2/bot/user/all/richmenu/{richMenuId}
//   - action の形は rich-menu-definitions.ts（postback / message / uri）
//
// トークン発行は client.ts（LineMessenger）の POST https://api.line.me/oauth2/v3/token
// （client_credentials）と同一パターンだが、client.ts はキャッシュ用の private closure に
// 閉じ込められており本スクリプトからは再利用できない（かつ client.ts は本タスクの変更禁止対象）。
// 本スクリプトは一度きりの実行で複数回のキャッシュ再利用も不要なため、素朴に再実装する。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildCompletedRichMenu,
  buildOnboardingRichMenu,
  type RichMenuObject,
} from './rich-menu-definitions.js';

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const CREATE_RICHMENU_URL = 'https://api.line.me/v2/bot/richmenu';
const UPLOAD_IMAGE_URL_BASE = 'https://api-data.line.me/v2/bot/richmenu';
const SET_DEFAULT_URL_BASE = 'https://api.line.me/v2/bot/user/all/richmenu';

// メニューの寸法・区画・action の定義は rich-menu-definitions.ts が持つ（作成と張り替えが
// 同じ定義を読むため）。本スクリプトの責務は、その定義を LINE へ登録する手順だけである。

export interface SetupCompletedRichMenuDeps {
  channelId: string;
  channelSecret: string;
  // グローバル fetch を直接使わず注入する（client.ts/places/search.ts と同じテスト容易性の規律）。
  fetch: typeof fetch;
  /** 完了後メニューの「詳細を見る」が開く URL（env LIFF_STORE_DETAIL_URL）。 */
  liffStoreDetailUrl: string;
  completedImage: Buffer;
}

export interface SetupRichMenusDeps extends SetupCompletedRichMenuDeps {
  onboardingImage: Buffer;
}

export interface SetupRichMenusResult {
  onboardingRichMenuId: string;
  completedRichMenuId: string;
}

export interface SetupCompletedRichMenuResult {
  completedRichMenuId: string;
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

/** 完了後メニューを 1 面作って画像を登録する（作成手順の共通部分）。 */
async function createCompletedRichMenu(
  deps: SetupCompletedRichMenuDeps,
  accessToken: string,
): Promise<string> {
  const richMenu: RichMenuObject = buildCompletedRichMenu(deps.liffStoreDetailUrl);
  const completedRichMenuId = await createRichMenu(deps, accessToken, richMenu);
  await uploadRichMenuImage(deps, accessToken, completedRichMenuId, deps.completedImage);
  return completedRichMenuId;
}

export async function setupRichMenus(deps: SetupRichMenusDeps): Promise<SetupRichMenusResult> {
  const accessToken = await issueAccessToken(deps);

  const onboardingRichMenuId = await createRichMenu(deps, accessToken, buildOnboardingRichMenu());
  await uploadRichMenuImage(deps, accessToken, onboardingRichMenuId, deps.onboardingImage);

  const completedRichMenuId = await createCompletedRichMenu(deps, accessToken);

  // Requirement 6.1: オンボーディング用メニューを全ユーザーのデフォルトに設定する。
  // 完了後メニューは per-user リンク専用（confirmStore 完了時に ConversationHandlers が
  // linkRichMenu で個別に切り替える。design.md stateDiagram 参照）であり、デフォルトにはしない。
  await setDefaultRichMenu(deps, accessToken, onboardingRichMenuId);

  return { onboardingRichMenuId, completedRichMenuId };
}

/**
 * 完了後メニューだけを作って画像を登録し、richMenuId を返す（`--completed-only`・
 * design.md「RichMenuDefinitions と RichMenuScripts」のスクリプトの契約）。
 *
 * メニューの差し替え（Migration Strategy の Step C）で使う。**既定メニューには触れない** —
 * 既定はオンボーディング用のままでなければならず（Requirement 2.6）、ここで既定を差し替えると
 * 店舗特定前のオーナーの面が壊れる。作った ID は張り替え（relink-completed-menu）へ渡す。
 */
export async function setupCompletedRichMenuOnly(
  deps: SetupCompletedRichMenuDeps,
): Promise<SetupCompletedRichMenuResult> {
  const accessToken = await issueAccessToken(deps);
  const completedRichMenuId = await createCompletedRichMenu(deps, accessToken);
  return { completedRichMenuId };
}

// CLI エントリポイント（運用者がデプロイ時に手動実行する）。
// 実行方法（ts/apps/line-webhook をカレントディレクトリとして）:
//   pnpm run build:scripts
//   LINE_CHANNEL_ID=... LINE_CHANNEL_SECRET=... LIFF_STORE_DETAIL_URL=... pnpm run setup-rich-menus
//   LINE_CHANNEL_ID=... LINE_CHANNEL_SECRET=... LIFF_STORE_DETAIL_URL=... \
//     pnpm run setup-rich-menus -- --completed-only
const isMainModule = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  void (async () => {
    const channelId = process.env.LINE_CHANNEL_ID;
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    const liffStoreDetailUrl = process.env.LIFF_STORE_DETAIL_URL;
    if (!channelId) {
      throw new Error('LINE_CHANNEL_ID is required');
    }
    if (!channelSecret) {
      throw new Error('LINE_CHANNEL_SECRET is required');
    }
    // 完了後メニューの「詳細を見る」の遷移先。2 つの動作のどちらでも完了後メニューを作るので必須である。
    if (!liffStoreDetailUrl) {
      throw new Error('LIFF_STORE_DETAIL_URL is required');
    }

    // assets/ はカレントディレクトリ（ts/apps/line-webhook）基準で解決する
    // （dist-scripts へのコンパイル後の出力階層に依存させないため）。
    const assetsDir = path.resolve(process.cwd(), 'assets');
    const completedImage = await readFile(path.join(assetsDir, 'richmenu-completed.png'));

    // メニューの差し替え（Migration Strategy の Step C）は完了後メニューだけを作り直す。
    // 既定メニュー（オンボーディング用）には触れない。
    if (process.argv.includes('--completed-only')) {
      const result = await setupCompletedRichMenuOnly({
        channelId,
        channelSecret,
        fetch,
        liffStoreDetailUrl,
        completedImage,
      });

      console.log('完了用リッチメニュー richMenuId:', result.completedRichMenuId);
      console.log('LINE_RICHMENU_COMPLETED_ID には上記の richMenuId を設定してください。');
      console.log('既存のオーナーへの張り替えは relink-completed-menu --to <上記の richMenuId> で行います。');
      return;
    }

    const onboardingImage = await readFile(path.join(assetsDir, 'richmenu-onboarding.png'));
    const result = await setupRichMenus({
      channelId,
      channelSecret,
      fetch,
      liffStoreDetailUrl,
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

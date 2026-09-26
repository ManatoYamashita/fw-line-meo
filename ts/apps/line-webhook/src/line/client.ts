// LINE Messaging API の注入面（design.md「LineMessenger」）。
// Requirement 4.3: 完了案内 reply の送信手段（MessageBuilders が組み立てたメッセージをそのまま渡す）。
// Requirement 5.5: 5秒応答予算に食い込ませない（トークン発行は初回のみ・以降はメモリキャッシュ）。
// Requirement 6.3: 完了時のリッチメニュー個別リンク（即時反映）。
// Requirement 7.2: getProfile は displayName のみを契約として返す（他フィールドは構造的に落とす）。
//
// stateless channel access token（有効 ~15分・発行無制限）を LINE_CHANNEL_ID＋SECRET で
// 実行時発行する（research.md「Decision 2」）。事前発行された長期チャネルアクセストークン
// （Secret Manager 管理）はここでは意図的に未配線（Console 運用・将来用に温存）。

import type { LogFields } from '@fwlm/observability';
import type { QuickReply } from './flex-types.js';

// LINE メッセージオブジェクトの wire 形状（references/message-objects.md 準拠）。
// 本タスクでは reply() の輸送に必要な最小限の variant のみを定義する。
// 具体的な文言・Flex コンテンツの組み立ては別タスク（MessageBuilders）が担う。
// テキストのクイックリプライは、レポートの店舗の選択肢（line-on-demand-report の Requirement 3.2）が使う。
export type LineMessage =
  | { type: 'text'; text: string; quickReply?: QuickReply }
  | { type: 'flex'; altText: string; contents: unknown };

export interface LineMessenger {
  reply(replyToken: string, messages: readonly LineMessage[], logger?: LineMessengerLogger): Promise<void>;
  /**
   * webhook の応答以外の契機（OAuth callback 等・gbp-post-review-reply Req 1.4/1.5/1.6）で
   * オーナーへ通知する。reply と異なり課金対象のため、reply で足りる場面では使わない。
   * 非2xx は reply と同じくログのみに留める（呼び出し元のフローを例外で中断させない）。
   */
  push(lineUserId: string, messages: readonly LineMessage[]): Promise<void>;
  getProfile(lineUserId: string): Promise<{ displayName: string } | null>;
  linkRichMenu(lineUserId: string, richMenuId: string): Promise<void>;
  /**
   * 処理中であることを示す入力中アニメーションを表示する（Issue #307）。1:1 チャット限定。
   * `loadingSeconds` は 5〜60。ボットが新しいメッセージを送るか、この秒数が経つと自動的に消える。
   * 呼出元は表示の開始を待ってから本処理へ進むこと（表示は「表示中に届いた新規メッセージ」でしか
   * 自動的に消えないため、reply の方が先に届く並びだと表示が消えずに残る）。
   */
  startLoading(lineUserId: string, loadingSeconds: number): Promise<void>;
  /** リクエスト単位のログ出力先を適用する。テスト用の偽実装では省略可能。 */
  withLogger?(logger: LineMessengerLogger): LineMessenger;
}

export interface LineMessengerLogger {
  /** 事象名で識別する。正典 docs/observability/log-field-canon.md に登録済みのものを使う。 */
  warn(event: string, fields?: LogFields): void;
}

export function withLineMessengerLogger(messenger: LineMessenger, logger: LineMessengerLogger): LineMessenger {
  // 偽 Messenger は元のオブジェクトをそのまま返し、reply の引数個数を変えない。
  // 実装本体だけが提供する withLogger を通して、リクエスト単位の logger を適用する。
  return messenger.withLogger ? messenger.withLogger(logger) : messenger;
}

export interface LineMessengerDeps {
  channelId: string;
  channelSecret: string;
  // グローバル fetch を直接使わず注入する（places/search.ts と同じテスト容易性の規律）。
  fetch: typeof fetch;
  // reply の非2xx（Invalid reply token 等）はここに warn ログを出す。再配信側で救済されるため
  // 例外にはしない（design.md「LineMessenger」の Responsibilities & Constraints）。
  logger: LineMessengerLogger;
}

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const PROFILE_URL_BASE = 'https://api.line.me/v2/bot/profile';
const USER_URL_BASE = 'https://api.line.me/v2/bot/user';
const LOADING_START_URL = 'https://api.line.me/v2/bot/chat/loading/start';

// startLoading はベストエフォートの補助表示であり、reply 経路（5秒応答目標）を巻き込んで
// 遅らせてはならない。places-search.ts と同じ AbortController の規律で上限を切る
// （固定・注入不可。呼出元が個別に調整する理由が無い）。
const LOADING_START_TIMEOUT_MS = 2000;

// stateless token の実効寿命は ~900秒（channel-token.md）。期限直前の利用による失敗を避けるため、
// 実際の expires_in からこのマージン分を差し引いた時点でキャッシュを無効化する。
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

interface RawTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

interface RawProfileResponse {
  displayName?: unknown;
}

export function createLineMessenger(deps: LineMessengerDeps): LineMessenger {
  // 有効期限内はこのクロージャ内メモリにキャッシュし、再発行を避ける（research.md Decision 2）。
  let cachedToken: CachedToken | null = null;

  async function getAccessToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAtMs > now) {
      return cachedToken.accessToken;
    }

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
      throw new Error(`LineMessenger: failed to issue channel access token (status ${response.status})`);
    }

    const parsed = (await response.json()) as RawTokenResponse;
    if (typeof parsed.access_token !== 'string' || typeof parsed.expires_in !== 'number') {
      throw new Error('LineMessenger: unexpected token issuance response shape');
    }

    cachedToken = {
      accessToken: parsed.access_token,
      expiresAtMs: now + Math.max(parsed.expires_in * 1000 - TOKEN_EXPIRY_SAFETY_MARGIN_MS, 0),
    };

    return cachedToken.accessToken;
  }

  const messenger: LineMessenger = {
    async reply(
      replyToken: string,
      messages: readonly LineMessage[],
      logger: LineMessengerLogger = deps.logger,
    ): Promise<void> {
      const accessToken = await getAccessToken();

      const response = await deps.fetch(REPLY_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ replyToken, messages }),
      });

      if (!response.ok) {
        // Invalid reply token（400）等。再配信側で救済されるため、呼び出し元の会話フローを
        // 例外で中断させずログのみに留める。
        logger.warn('line-webhook.reply_failed', { status: response.status });
      }
    },

    async push(lineUserId: string, messages: readonly LineMessage[]): Promise<void> {
      const accessToken = await getAccessToken();

      const response = await deps.fetch(PUSH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ to: lineUserId, messages }),
      });

      if (!response.ok) {
        // ブロック済みユーザー・月次クォータ超過等。呼び出し元（OAuth callback）の応答を
        // 妨げないためログのみに留める。userId・本文はログに載せない。
        deps.logger.warn('line push failed', { status: response.status });
      }
    },

    async getProfile(lineUserId: string): Promise<{ displayName: string } | null> {
      const accessToken = await getAccessToken();

      const response = await deps.fetch(`${PROFILE_URL_BASE}/${encodeURIComponent(lineUserId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (response.status === 404) {
        // ブロック・未フォロー等で識別不能（references/user.md）。
        return null;
      }

      if (!response.ok) {
        throw new Error(`LineMessenger: getProfile failed with status ${response.status}`);
      }

      const parsed = (await response.json()) as RawProfileResponse;
      if (typeof parsed.displayName !== 'string') {
        throw new Error('LineMessenger: unexpected profile response shape');
      }

      // Requirement 7.2: displayName 以外のフィールド（pictureUrl/statusMessage/language/userId 等）
      // は契約から構造的に落とす。レスポンスのスプレッドではなく新規オブジェクトを組み立てることで、
      // 「たまたま displayName しか読んでいない」ではなく「他フィールドを返しようがない」ことを保証する。
      return { displayName: parsed.displayName };
    },

    async linkRichMenu(lineUserId: string, richMenuId: string): Promise<void> {
      const accessToken = await getAccessToken();

      const response = await deps.fetch(
        `${USER_URL_BASE}/${encodeURIComponent(lineUserId)}/richmenu/${encodeURIComponent(richMenuId)}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );

      if (!response.ok) {
        throw new Error(`LineMessenger: linkRichMenu failed with status ${response.status}`);
      }
    },

    async startLoading(lineUserId: string, loadingSeconds: number): Promise<void> {
      const accessToken = await getAccessToken();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LOADING_START_TIMEOUT_MS);

      try {
        const response = await deps.fetch(LOADING_START_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ chatId: lineUserId, loadingSeconds }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`LineMessenger: startLoading failed with status ${response.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    },

    withLogger(logger: LineMessengerLogger): LineMessenger {
      return {
        reply: (replyToken, messages) => messenger.reply(replyToken, messages, logger),
        push: (lineUserId, messages) => messenger.push(lineUserId, messages),
        getProfile: (lineUserId) => messenger.getProfile(lineUserId),
        linkRichMenu: (lineUserId, richMenuId) => messenger.linkRichMenu(lineUserId, richMenuId),
        startLoading: (lineUserId, loadingSeconds) => messenger.startLoading(lineUserId, loadingSeconds),
        withLogger: (nextLogger) => withLineMessengerLogger(messenger, nextLogger),
      };
    },
  };

  return messenger;
}

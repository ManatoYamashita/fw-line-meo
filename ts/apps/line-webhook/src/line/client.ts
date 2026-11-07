// LINE Messaging API の注入面（design.md「LineMessenger」）。
// Requirement 4.3: 完了案内 reply の送信手段（MessageBuilders が組み立てたメッセージをそのまま渡す）。
// Requirement 5.5: 5秒応答予算に食い込ませない（トークン発行は初回のみ・以降はメモリキャッシュ）。
// Requirement 6.3: 完了時のリッチメニュー個別リンク（即時反映）。
// owner-line-unlink Requirement 3.1: 個別リンクの解除（未登録の友だち追加の安全網・onboarding/conversation.ts）。
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
   * LINE ユーザーの個別リッチメニューのリンクを外す（owner-line-unlink Requirement 3.1）。
   * 外すと、そのユーザーには既定リッチメニュー（未登録の利用者と同じメニュー）が表示される。
   * トークンと非 2xx の扱いは linkRichMenu と同じ（非 2xx は例外）。ただし 404 は外すリンクが無い状態として成功とする。
   */
  unlinkRichMenu(lineUserId: string): Promise<void>;
  /**
   * 処理中であることを示す入力中アニメーションを表示する（Issue #307）。1:1 チャット限定。
   * `loadingSeconds` は 5〜60。ボットが新しいメッセージを送るか、この秒数が経つと自動的に消える。
   * 呼出元は表示の開始を待ってから本処理へ進むこと（表示は「表示中に届いた新規メッセージ」でしか
   * 自動的に消えないため、reply の方が先に届く並びだと表示が消えずに残る）。
   */
  startLoading(lineUserId: string, loadingSeconds: number): Promise<void>;
  /**
   * 利用者が送った画像などの本体を取得する（Content API・line-crosspost Requirement 2.1）。
   * LINE は保存期間を保証しないので、Webhook を受けたらすぐ取得する。`maxBytes` を超えたら読み止める。
   * 例外を投げるのはトークンの発行の失敗と時間切れだけで、それ以外は結果の種類で返す。
   * 一括発信を使わない偽実装では省略可能（省略時、一括発信は写真を受け取れない）。
   */
  getMessageContent?(messageId: string, maxBytes: number): Promise<MessageContentResult>;
  /** リクエスト単位のログ出力先を適用する。テスト用の偽実装では省略可能。 */
  withLogger?(logger: LineMessengerLogger): LineMessenger;
}

/** Content API の結果。本体・Content-Type 以外（応答本文の文言など）は持たない。 */
export type MessageContentResult =
  | { kind: 'ok'; bytes: Buffer; contentType: string | null }
  /** 送信の取り消し・保存期間切れなどで、もう取得できない（404・410）。 */
  | { kind: 'gone' }
  /** 本体の準備中（202。動画・音声で起きる）。 */
  | { kind: 'not_ready' }
  /** 上限を超えた。 */
  | { kind: 'too_large' }
  | { kind: 'error'; status: number };

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
  // LINE への 1 回の通信（トークン発行・reply・push・プロフィール・個別メニューの張り外しのそれぞれ）に
  // 許す時間（ミリ秒）。応答が止まった LINE を待ち続けて Webhook の処理を塞がないための上限（Issue #499）。
  // startLoading だけは補助表示なので、これより短い固定の上限（LOADING_START_TIMEOUT_MS）を使う。
  requestTimeoutMs: number;
}

/**
 * LINE への通信が時間制限を超えたことを表す例外（Issue #499）。
 * 記録は例外のクラス名を errorKind として載せるので、時間切れはこの名前で他の失敗と区別できる。
 * 文言には URL・LINE ユーザー ID・トークンを載せない。
 */
export class LineRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LineMessenger: request timed out after ${timeoutMs}ms`);
    this.name = 'LineRequestTimeoutError';
  }
}

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const PROFILE_URL_BASE = 'https://api.line.me/v2/bot/profile';
const USER_URL_BASE = 'https://api.line.me/v2/bot/user';
const LOADING_START_URL = 'https://api.line.me/v2/bot/chat/loading/start';
const CONTENT_URL_BASE = 'https://api-data.line.me/v2/bot/message';
// Webhook の message.id の形（10 進の数字列）。パスを組み立てる前に確かめる。
const MESSAGE_ID_PATTERN = /^\d{1,32}$/;
// LINE のユーザー ID の形（Webhook の source.userId）。unlinkRichMenu がパスを組み立てる前に確かめる。
const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;

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

/** 実装本体（Content API の取得を必ず持つ）。 */
export type ConcreteLineMessenger = LineMessenger & Required<Pick<LineMessenger, 'getMessageContent'>>;

export function createLineMessenger(deps: LineMessengerDeps): ConcreteLineMessenger {
  // 有効期限内はこのクロージャ内メモリにキャッシュし、再発行を避ける（research.md Decision 2）。
  let cachedToken: CachedToken | null = null;

  /**
   * LINE へ 1 回通信し、応答の読み出しまでを `timeoutMs` の内に収める。超えたら通信を打ち切り、
   * LineRequestTimeoutError を投げる。それ以外の失敗（通信の失敗・handle が投げた例外）はそのまま投げる。
   * 本文の読み出し（response.json()）も時間制限の内に置くため、handle の終わりまでタイマーを止めない。
   * AbortSignal.timeout ではなく setTimeout を使うのは、偽のタイマーで試験から進められるようにするため
   * （startLoading の従来の規律と同じ）。
   */
  async function send<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    handle: (response: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await deps.fetch(url, { ...init, signal: controller.signal });
      return await handle(response);
    } catch (err) {
      // 打ち切りの理由は fetch の実装ごとに異なる例外（AbortError など）で届くので、例外の形ではなく
      // 自分で時間切れを起こしたかどうかで判定する。
      if (timedOut) {
        throw new LineRequestTimeoutError(timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

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

    const parsed = await send(
      TOKEN_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      deps.requestTimeoutMs,
      async (response) => {
        if (!response.ok) {
          throw new Error(`LineMessenger: failed to issue channel access token (status ${response.status})`);
        }
        return (await response.json()) as RawTokenResponse;
      },
    );
    if (typeof parsed.access_token !== 'string' || typeof parsed.expires_in !== 'number') {
      throw new Error('LineMessenger: unexpected token issuance response shape');
    }

    cachedToken = {
      accessToken: parsed.access_token,
      expiresAtMs: now + Math.max(parsed.expires_in * 1000 - TOKEN_EXPIRY_SAFETY_MARGIN_MS, 0),
    };

    return cachedToken.accessToken;
  }

  const messenger: ConcreteLineMessenger = {
    async reply(
      replyToken: string,
      messages: readonly LineMessage[],
      logger: LineMessengerLogger = deps.logger,
    ): Promise<void> {
      const accessToken = await getAccessToken();

      const response = await send(
        REPLY_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ replyToken, messages }),
        },
        deps.requestTimeoutMs,
        async (res) => res,
      );

      if (!response.ok) {
        // Invalid reply token（400）等。再配信側で救済されるため、呼び出し元の会話フローを
        // 例外で中断させずログのみに留める。
        logger.warn('line-webhook.reply_failed', { status: response.status });
      }
    },

    async push(lineUserId: string, messages: readonly LineMessage[]): Promise<void> {
      const accessToken = await getAccessToken();

      const response = await send(
        PUSH_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ to: lineUserId, messages }),
        },
        deps.requestTimeoutMs,
        async (res) => res,
      );

      if (!response.ok) {
        // ブロック済みユーザー・月次クォータ超過等。呼び出し元（OAuth callback）の応答を
        // 妨げないためログのみに留める。userId・本文はログに載せない。
        deps.logger.warn('line push failed', { status: response.status });
      }
    },

    async getProfile(lineUserId: string): Promise<{ displayName: string } | null> {
      const accessToken = await getAccessToken();

      const parsed = await send(
        `${PROFILE_URL_BASE}/${encodeURIComponent(lineUserId)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        deps.requestTimeoutMs,
        async (response): Promise<RawProfileResponse | null> => {
          if (response.status === 404) {
            // ブロック・未フォロー等で識別不能（references/user.md）。
            return null;
          }

          if (!response.ok) {
            throw new Error(`LineMessenger: getProfile failed with status ${response.status}`);
          }

          return (await response.json()) as RawProfileResponse;
        },
      );

      if (parsed === null) {
        return null;
      }
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

      const response = await send(
        `${USER_URL_BASE}/${encodeURIComponent(lineUserId)}/richmenu/${encodeURIComponent(richMenuId)}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        deps.requestTimeoutMs,
        async (res) => res,
      );

      if (!response.ok) {
        throw new Error(`LineMessenger: linkRichMenu failed with status ${response.status}`);
      }
    },

    // 契約の根拠: .claude/skills/messaging-api/references/rich-menu.md「Per-user Rich Menu」と
    // @line/bot-sdk の生成型（MessagingApiClient.unlinkRichMenuIdFromUser）。
    // `DELETE https://api.line.me/v2/bot/user/{userId}/richmenu`。
    //
    // - 404 は成功として扱う。個別リンクが無いユーザーへの応答が文書化されておらず、dashboard-api の
    //   LineRichMenuAdapter（line-richmenu.ts）と同じ判断に揃える。未登録の友だち追加のたびに呼ぶので、
    //   リンクの無いユーザーを失敗として数えると記録が雑音で埋まる。
    // - LINE ユーザー ID の形に合わない値は、トークンの発行も含めて通信せずに例外を投げる。encodeURIComponent は
    //   `all` や `..` を通し、`DELETE /v2/bot/user/all/richmenu` は既定リッチメニューの解除という別の操作である
    //   （全ての未登録の利用者からメニューが消える）。ID は Webhook の source.userId からしか来ないが、
    //   パスの組み立てで別の操作へ届かないことを、呼び出し元に依らずここで保つ。
    // - 例外の文言には状態コードだけを載せ、LINE ユーザー ID は載せない。
    async unlinkRichMenu(lineUserId: string): Promise<void> {
      if (!LINE_USER_ID_PATTERN.test(lineUserId)) {
        throw new Error('LineMessenger: unlinkRichMenu refused a value that is not a LINE user ID');
      }

      const accessToken = await getAccessToken();

      const response = await send(
        `${USER_URL_BASE}/${encodeURIComponent(lineUserId)}/richmenu`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        deps.requestTimeoutMs,
        async (res) => res,
      );

      if (!response.ok && response.status !== 404) {
        throw new Error(`LineMessenger: unlinkRichMenu failed with status ${response.status}`);
      }
    },

    async startLoading(lineUserId: string, loadingSeconds: number): Promise<void> {
      const accessToken = await getAccessToken();

      const response = await send(
        LOADING_START_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ chatId: lineUserId, loadingSeconds }),
        },
        LOADING_START_TIMEOUT_MS,
        async (res) => res,
      );

      if (!response.ok) {
        throw new Error(`LineMessenger: startLoading failed with status ${response.status}`);
      }
    },

    async getMessageContent(messageId: string, maxBytes: number): Promise<MessageContentResult> {
      if (!MESSAGE_ID_PATTERN.test(messageId)) return { kind: 'gone' };
      const accessToken = await getAccessToken();
      return send(
        `${CONTENT_URL_BASE}/${messageId}/content`,
        { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
        deps.requestTimeoutMs,
        async (response): Promise<MessageContentResult> => {
          if (response.status === 202) return { kind: 'not_ready' };
          if (response.status === 404 || response.status === 410) return { kind: 'gone' };
          if (!response.ok) return { kind: 'error', status: response.status };
          const declared = Number(response.headers.get('content-length'));
          if (Number.isFinite(declared) && declared > maxBytes) {
            await response.body?.cancel();
            return { kind: 'too_large' };
          }
          const chunks: Uint8Array[] = [];
          let total = 0;
          const reader = response.body?.getReader();
          if (!reader) return { kind: 'error', status: response.status };
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
              await reader.cancel();
              return { kind: 'too_large' };
            }
            chunks.push(value);
          }
          return { kind: 'ok', bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type') };
        },
      );
    },

    withLogger(logger: LineMessengerLogger): LineMessenger {
      return {
        reply: (replyToken, messages) => messenger.reply(replyToken, messages, logger),
        push: (lineUserId, messages) => messenger.push(lineUserId, messages),
        getProfile: (lineUserId) => messenger.getProfile(lineUserId),
        linkRichMenu: (lineUserId, richMenuId) => messenger.linkRichMenu(lineUserId, richMenuId),
        unlinkRichMenu: (lineUserId) => messenger.unlinkRichMenu(lineUserId),
        startLoading: (lineUserId, loadingSeconds) => messenger.startLoading(lineUserId, loadingSeconds),
        getMessageContent: (messageId, maxBytes) => messenger.getMessageContent(messageId, maxBytes),
        withLogger: (nextLogger) => withLineMessengerLogger(messenger, nextLogger),
      };
    },
  };

  return messenger;
}

// LINE の個別リッチメニューのリンクを外すアダプタ（owner-line-unlink Req 3.1, 3.4・design.md「LineRichMenuAdapter」）。
//
// 公開する操作は unlinkUserRichMenu の 1 つだけである。dashboard-api はトークンの発行に
// line-channel-secret を使い、発行したトークンは push を含む LINE の全操作に使えてしまう。
// そこでこのアダプタは個別リンクの解除以外の経路をコードに持たない（design.md「Security Considerations」）。
// 操作を足すときは設計の見直し対象とする。
//
// 契約の根拠:
//   - .claude/skills/messaging-api/references/channel-token.md「Stateless Channel Access Token」と
//     @line/bot-sdk の生成型（ChannelAccessTokenClient.issueStatelessChannelToken・
//     IssueStatelessChannelAccessTokenResponse）: `POST https://api.line.me/oauth2/v3/token` に
//     application/x-www-form-urlencoded で grant_type=client_credentials・client_id・client_secret を送り、
//     応答の access_token を使う。
//   - .claude/skills/messaging-api/references/rich-menu.md「Per-user Rich Menu」と
//     @line/bot-sdk の生成型（MessagingApiClient.unlinkRichMenuIdFromUser）:
//     `DELETE https://api.line.me/v2/bot/user/{userId}/richmenu`。userId はパスの 1 区画としてエンコードする。
//
// 方針:
//   - トークンは呼び出しごとに発行し、キャッシュしない（解除の操作は頻度が低い）。
//   - 2xx と 404 を成功とする。個別リンクが無いユーザーへの応答が文書化されていないため、
//     404 を失敗にすると外し直しが永久に終わらない事態がありうる（本番の確認で実測する）。
//   - LINE ユーザー ID の形（U に続く 16 進 32 桁）に合わない値は、トークンを発行する前に invalid_user_id で返す。
//     encodeURIComponent は `all` や `..` を通すので、`/v2/bot/user/all/richmenu`（既定リッチメニューの解除という
//     別の操作）や URL の正規化で別のパスへ届きうる。ID は DB の列からしか来ないが、解除以外の操作を持たない
//     という上の方針を、パスの組み立てでも崩さないための防御である。
//   - 例外を投げず、失敗は種別つきの結果で返す。記録（ログ）は呼び出し元が行い、
//     このアダプタは何も記録しない。結果には応答本文・トークン・LINE ユーザー ID を載せない。

export type UnlinkRichMenuResult =
  | { ok: true }
  | {
      ok: false;
      errorKind: 'invalid_user_id' | 'token_failed' | 'http_error' | 'network_error';
      httpStatus: number | null;
    };

export interface LineRichMenuAdapter {
  unlinkUserRichMenu(lineUserId: string): Promise<UnlinkRichMenuResult>;
}

export interface LineRichMenuAdapterDeps {
  channelId: string;
  channelSecret: string;
  // グローバルの fetch を直接使わず注入する。試験は偽の fetch を渡し、api.line.me へ出ない。
  fetch: typeof fetch;
  // 1 回の通信（トークン発行・DELETE のそれぞれ）に許す時間（ミリ秒）。
  timeoutMs: number;
}

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const USER_URL_BASE = 'https://api.line.me/v2/bot/user';
// LINE のユーザー ID の形（Webhook の source.userId）。
const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;

type TokenOutcome = { ok: true; accessToken: string } | { ok: false; httpStatus: number | null };

export function createLineRichMenuAdapter(deps: LineRichMenuAdapterDeps): LineRichMenuAdapter {
  async function issueToken(): Promise<TokenOutcome> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: deps.channelId,
      client_secret: deps.channelSecret,
    });

    let response: Response;
    try {
      response = await deps.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
    } catch {
      // swallowed-exception: intentional — 通信の失敗・時間切れは token_failed（状態コードなし）として
      // 呼び出し元へ返し、呼び出し元がメニュー未解除の印とログで観測できるようにする。
      // 例外の文言は捨てる（ネットワーク層の文言に URL や識別子が混ざりうるため）。
      return { ok: false, httpStatus: null };
    }

    if (!response.ok) {
      // 応答本文は読まない（記録に載せない方針。失敗の判別は状態コードで足りる）。
      return { ok: false, httpStatus: response.status };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      // swallowed-exception: intentional — 壊れた本文・本文の読み出し中の時間切れは token_failed として返す。
      return { ok: false, httpStatus: response.status };
    }

    const accessToken =
      typeof parsed === 'object' && parsed !== null ? (parsed as { access_token?: unknown }).access_token : undefined;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return { ok: false, httpStatus: response.status };
    }
    return { ok: true, accessToken };
  }

  return {
    async unlinkUserRichMenu(lineUserId: string): Promise<UnlinkRichMenuResult> {
      if (!LINE_USER_ID_PATTERN.test(lineUserId)) {
        return { ok: false, errorKind: 'invalid_user_id', httpStatus: null };
      }
      const token = await issueToken();
      if (!token.ok) {
        return { ok: false, errorKind: 'token_failed', httpStatus: token.httpStatus };
      }

      let response: Response;
      try {
        response = await deps.fetch(`${USER_URL_BASE}/${encodeURIComponent(lineUserId)}/richmenu`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token.accessToken}` },
          signal: AbortSignal.timeout(deps.timeoutMs),
        });
      } catch {
        // swallowed-exception: intentional — 通信の失敗・時間切れは network_error として呼び出し元へ返す。
        // 例外の文言には URL（LINE ユーザー ID を含む）が混ざりうるので捨てる。
        return { ok: false, errorKind: 'network_error', httpStatus: null };
      }

      if (response.ok || response.status === 404) {
        return { ok: true };
      }
      return { ok: false, errorKind: 'http_error', httpStatus: response.status };
    },
  };
}

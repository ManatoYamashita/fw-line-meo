// LINE Push クライアント（Task 4.2）。
//
// 責務は「Stateless channel access token の発行」と「Push 1 件の送信・分類・再送」のみ。
// 対象抽出・summary_deliveries への書込（retry_key 発行含む）・オーケストレーションは対象外
// （task 4.3/4.4 の責務）。retry_key は summary_deliveries 行が source of truth であり、
// 本モジュールは呼出元から常に受け取る（内部で UUID を生成しない）。
//
// 契約の根拠:
//   - design.md「Idempotency & recovery」: 配信前に summary_deliveries 行を retry_key 付きで確保。
//     Push には常に X-Line-Retry-Key を付与。500/タイムアウトのみ同一キーで再送、409 は成功扱い。
//     X-Line-Request-Id を行に記録。
//   - design.md「失敗分類」: 400（無効 userId）= failed 記録・継続／429（月次クォータ）=
//     残対象を quota_exceeded で記録し終了。
//   - research.md「LINE Messaging API — Push・Flex・LIFF」: X-Line-Retry-Key は初回リクエストから
//     付与・24h 有効・内容完全一致が必須。再送は 500/タイムアウトのみ（200/409/他4xx は再送しない）。
//     トークンは Stateless（約15分・発行数無制限）が日次バッチに最適。X-Line-Request-Id は必ずログ保存。
//   - .claude/skills/messaging-api/references/api-common.md「Common Error Messages」:
//     429 は "You have reached your monthly limit."（月次クォータ超過）と
//     "The API rate limit has been exceeded."（レート制限）をメッセージ本文で判別する
//     （ステータスコードのみでは区別できない）。
//   - .claude/skills/messaging-api/references/channel-token.md「Stateless Channel Access Token」:
//     `POST https://api.line.me/oauth2/v3/token` に grant_type=client_credentials・client_id・
//     client_secret を渡す方式（Method 1）。JWT 方式（Method 2）は鍵管理基盤が別途必要なため
//     本タスクでは採用しない（CONCERNS 参照）。

const DEFAULT_TOKEN_ENDPOINT = 'https://api.line.me/oauth2/v3/token';
const DEFAULT_PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

const DEFAULT_BACKOFF_BASE_MS = 100;
const DEFAULT_BACKOFF_MAX_MS = 5_000;
const DEFAULT_MAX_RETRIES = 5;
/** 1 リクエストあたりの許容時間。超過は「タイムアウト」として 500 と同じ再送対象に分類する。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

// --- 認証情報・トークン ------------------------------------------------------------

export interface LineCredentials {
  readonly channelId: string;
  readonly channelSecret: string;
}

export interface LineAccessToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

/**
 * Stateless channel access token の発行に失敗した場合に送出する。
 * message は LINE のエラーレスポンス本文由来のみを保持し、channelSecret・access_token を
 * 一切含めない（セキュリティ制約: トークン・シークレットをログ/エラーに露出させない）。
 */
export class LineTokenIssuanceError extends Error {
  readonly httpStatus: number | null;

  constructor(httpStatus: number | null, message: string) {
    super(`LINE stateless token issuance failed (status ${httpStatus ?? 'network error'}): ${message}`);
    this.name = 'LineTokenIssuanceError';
    this.httpStatus = httpStatus;
  }
}

// --- Push 結果の分類 ----------------------------------------------------------------

export interface LinePushSuccess {
  readonly status: 'success';
  /** true = 409（同一 Retry-Key の重複検知）による成功扱い。false = 200 による通常成功。 */
  readonly duplicate: boolean;
  readonly requestId: string | null;
}

export interface LinePushFailed {
  readonly status: 'failed';
  readonly requestId: string | null;
  /** ネットワークエラー/タイムアウトが再送上限に達した場合は null。 */
  readonly httpStatus: number | null;
  readonly message: string;
}

export interface LinePushQuotaExceeded {
  readonly status: 'quota_exceeded';
  readonly requestId: string | null;
  readonly message: string;
}

/**
 * summary_deliveries.status（'delivered' | 'failed' | 'skipped_no_summary' | 'quota_exceeded'）に
 * そのまま対応させられるよう設計した結果型。'skipped_no_summary' は対象抽出（task 4.3）の責務。
 */
export type LinePushResult = LinePushSuccess | LinePushFailed | LinePushQuotaExceeded;

// --- クライアント本体 ----------------------------------------------------------------

export interface LineClientOptions {
  /** テスト用にトークン発行エンドポイントを差し替える。 */
  readonly tokenEndpoint?: string;
  /** テスト用に Push エンドポイントを差し替える。 */
  readonly pushEndpoint?: string;
  /** テスト用に fetch 実装を差し替える（タイムアウト等の疑似発生に使う）。 */
  readonly fetchImpl?: typeof fetch;
  /** 再送の初期待機時間（ミリ秒）。 */
  readonly backoffBaseMs?: number;
  /** 再送の待機時間上限（ミリ秒）。 */
  readonly backoffMaxMs?: number;
  /** 500/タイムアウト時の最大再送回数（初回を含まない）。 */
  readonly maxRetries?: number;
  /** テスト用に待機処理を差し替える（実時間を消費しないため）。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 1 リクエストあたりのタイムアウト（ミリ秒）。 */
  readonly requestTimeoutMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 指数バックオフの待機時間を計算する（go/internal/places/client.go の backoffDelay と同じ方針）。 */
function backoffDelayMs(baseMs: number, maxMs: number, attempt: number): number {
  if (baseMs <= 0) {
    return 0;
  }
  const delay = baseMs * Math.pow(2, attempt);
  if (!Number.isFinite(delay) || delay > maxMs) {
    return maxMs;
  }
  return delay;
}

/**
 * 429 のレスポンス本文メッセージから「月次クォータ超過」か「レート制限」かを判別する。
 * api-common.md の Common Error Messages に基づく既知の文言（"monthly limit"）を手掛かりにする。
 * 将来 LINE 側の文言が変わっても未知の 429 は quota 扱いにせず failed（非再送）に倒す
 * （無駄な即時終了を避ける安全側の判断）。
 */
function isQuotaExceededMessage(message: string): boolean {
  return /monthly/i.test(message);
}

/** LINE のエラーレスポンス本文（JSON）から message フィールドを取り出す。JSON でなければ生本文を使う。 */
function extractErrorMessage(rawBody: string): string {
  if (rawBody.length === 0) {
    return '';
  }
  try {
    const parsed = JSON.parse(rawBody) as { message?: unknown };
    if (typeof parsed.message === 'string') {
      return parsed.message;
    }
  } catch {
    // JSON でない場合は生本文をそのまま使う。
  }
  return rawBody;
}

type PushAttemptOutcome =
  | { readonly kind: 'success'; readonly duplicate: boolean; readonly requestId: string | null }
  | { readonly kind: 'retryable'; readonly requestId: string | null; readonly httpStatus: number | null; readonly message: string }
  | { readonly kind: 'failed'; readonly requestId: string | null; readonly httpStatus: number | null; readonly message: string }
  | { readonly kind: 'quota_exceeded'; readonly requestId: string | null; readonly message: string };

/**
 * LINE Messaging API への唯一の呼出口（design.md Boundary: delivery-job/line）。
 * Push は messages の内容に関わらず送信のみを担当し、Flex JSON の組立（flex.ts）や
 * 配信対象・記録（task 4.3）とは責務を分離する。
 */
export class LineClient {
  private readonly channelId: string;
  private readonly channelSecret: string;
  private readonly tokenEndpoint: string;
  private readonly pushEndpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly requestTimeoutMs: number;

  constructor(credentials: LineCredentials, options: LineClientOptions = {}) {
    this.channelId = credentials.channelId;
    this.channelSecret = credentials.channelSecret;
    this.tokenEndpoint = options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
    this.pushEndpoint = options.pushEndpoint ?? DEFAULT_PUSH_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = options.sleep ?? defaultSleep;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Stateless channel access token を発行する（有効約15分）。ジョブ開始時に一度発行し、
   * 長時間実行時の再発行判断は呼出元（task 4.4）の責務とする（本メソッドは単発発行のみ）。
   */
  async issueAccessToken(): Promise<LineAccessToken> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.channelId,
      client_secret: this.channelSecret,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(this.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch {
      // fetch 例外の詳細（ネットワークスタックのメッセージ）にシークレットは含まれないが、
      // 念のため固定文言のみを使う。
      throw new LineTokenIssuanceError(null, 'network error while requesting stateless token');
    }

    const rawBody = await response.text();
    if (!response.ok) {
      throw new LineTokenIssuanceError(response.status, extractErrorMessage(rawBody));
    }

    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(rawBody) as { access_token?: unknown; expires_in?: unknown };
    } catch {
      throw new LineTokenIssuanceError(response.status, 'malformed token response body');
    }

    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new LineTokenIssuanceError(response.status, 'token response missing access_token');
    }
    if (typeof parsed.expires_in !== 'number') {
      throw new LineTokenIssuanceError(response.status, 'token response missing expires_in');
    }

    return { accessToken: parsed.access_token, expiresInSeconds: parsed.expires_in };
  }

  /**
   * 1 件の Push を送信する。retryKey は呼出元が summary_deliveries 行に確保した値をそのまま渡す
   * （内部で生成・変更しない）。500/タイムアウトのみ同一 retryKey で指数バックオフ再送する。
   */
  async pushMessage(
    accessToken: string,
    lineUserId: string,
    messages: readonly unknown[],
    retryKey: string,
  ): Promise<LinePushResult> {
    const requestBody = JSON.stringify({ to: lineUserId, messages });

    for (let attempt = 0; ; attempt++) {
      const outcome = await this.attemptPush(accessToken, requestBody, retryKey);

      if (outcome.kind === 'success') {
        return { status: 'success', duplicate: outcome.duplicate, requestId: outcome.requestId };
      }
      if (outcome.kind === 'failed') {
        return {
          status: 'failed',
          requestId: outcome.requestId,
          httpStatus: outcome.httpStatus,
          message: outcome.message,
        };
      }
      if (outcome.kind === 'quota_exceeded') {
        return { status: 'quota_exceeded', requestId: outcome.requestId, message: outcome.message };
      }

      // outcome.kind === 'retryable'（500・タイムアウト）
      if (attempt >= this.maxRetries) {
        return {
          status: 'failed',
          requestId: outcome.requestId,
          httpStatus: outcome.httpStatus,
          message: `exceeded max retries (${this.maxRetries}): ${outcome.message}`,
        };
      }

      await this.sleep(backoffDelayMs(this.backoffBaseMs, this.backoffMaxMs, attempt));
    }
  }

  /** Push を 1 回だけ試行し、結果を分類する（再送要否の判断は呼出元 pushMessage が行う）。 */
  private async attemptPush(
    accessToken: string,
    requestBody: string,
    retryKey: string,
  ): Promise<PushAttemptOutcome> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.pushEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Line-Retry-Key': retryKey,
        },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (err) {
      // タイムアウト（AbortError）・DNS/接続エラー等はすべて「タイムアウト」と同じ再送対象に分類する
      // （research.md: 再送は 500/タイムアウトのみ）。access token 自体はエラーに含めない。
      const reason = err instanceof Error && err.name === 'AbortError' ? 'request timeout' : 'network error';
      return { kind: 'retryable', requestId: null, httpStatus: null, message: reason };
    } finally {
      clearTimeout(timeout);
    }

    const requestId = response.headers.get('X-Line-Request-Id');
    const rawBody = await response.text();

    if (response.status === 200) {
      return { kind: 'success', duplicate: false, requestId };
    }
    if (response.status === 409) {
      // 同一 Retry-Key の重複検知＝既に送信済み＝成功扱い（再送しない）。
      return { kind: 'success', duplicate: true, requestId };
    }
    if (response.status === 429) {
      const message = extractErrorMessage(rawBody);
      if (isQuotaExceededMessage(message)) {
        return { kind: 'quota_exceeded', requestId, message };
      }
      // レート制限（月次クォータではない）は再送しない failed 扱い
      // （summary_deliveries.status に rate_limited 専用値は無い）。
      return { kind: 'failed', requestId, httpStatus: 429, message };
    }
    if (response.status >= 500) {
      return { kind: 'retryable', requestId, httpStatus: response.status, message: extractErrorMessage(rawBody) };
    }
    // 400 等その他 4xx は失敗記録・継続（再送しない）。
    return { kind: 'failed', requestId, httpStatus: response.status, message: extractErrorMessage(rawBody) };
  }
}

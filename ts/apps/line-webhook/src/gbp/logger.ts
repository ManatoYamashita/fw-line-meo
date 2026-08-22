// GBP ドメインの構造化ログ（design.md「Monitoring」・PR #121 レビュー指摘の是正）。
//
// design.md は「構造化ログ: flow/stage 遷移・GBP API status・生成の成否（**本文・トークンは
// 記録しない**）」を要求しているが、gbp/ 配下でロガーを持つのは callback.ts だけで、
// GbpFlows / GbpClient / GbpPrompts / TokenStore は 1 行も記録していなかった。
// `executeLocalPost` などの `catch {}` が例外を `upstream_error status 0` へ畳むため、
// 本番では「GBP 呼び出しが全件失敗しても Cloud Logging に何も出ない」状態だった。
// infra/README.md §9 が最有力の障害と書く「利用審査未承認でクォータ 0」が、
// オーナーからの問い合わせ以外に観測できない。
//
// 設計上の不変条件:
// - **meta は allowlist（GbpLogMeta）**。下書き本文・オーナー入力・クチコミ本文・トークン・
//   認可コード・暗号鍵は **型として渡せない**。free-form な `Record<string, unknown>` に
//   しないのは、それが「うっかり載る」唯一の経路だからである。
// - **sink 側でも明示的に取り出す**。渡された object をそのまま spread すると、型検査を
//   通り抜けた余剰プロパティが Cloud Logging へ永続化される。TypeScript の excess property
//   check は「その場で書かれた object literal」にしか効かず、変数・関数戻り値・キャスト経由の
//   余剰プロパティは構造的部分型として合法に通るため、**型ではこの経路を塞げない**
//   （survey-web の structured-log.ts が PR #75 レビューで実測した教訓）。
// - Error の **message は決して載せない**。google-auth-library の GaxiosError は `config.data`
//   にリクエストボディ（`code=...` / `client_secret=...` / `refresh_token=...`）を保持し、
//   pg のエラーは接続文字列を含みうる。載せてよいのは `name` だけ（`errorName`）。

import type { GbpFlow, GbpStage } from '@fwlm/db';

/**
 * ログへ載せてよい項目の全集合。**ここに無い値は記録できない。**
 * 追加するときは下の sink（`writeGbpLog`）の取り出しも必ず更新する（型で強制している）。
 */
export interface GbpLogMeta {
  /** 会話フロー（connect / post / reply）。 */
  flow?: GbpFlow;
  /** 状態機械の段階。 */
  stage?: GbpStage;
  /** OAuth callback の結果種別（`OauthCallbackResult['kind']`）。 */
  kind?: string;
  /** 通知先・所有検証の主体。UUID であって個人情報ではない。 */
  ownerId?: string;
  storeId?: string;
  /** `GbpApiError['kind']` / `GenerationError['kind']` / `TokenStoreError['kind']`。 */
  errorKind?: string;
  /** **`Error.name` のみ**。message は載せない（上の不変条件を参照）。 */
  errorName?: string;
  /** HTTP ステータス。`upstream_error` の 0 は「ネットワーク断・解釈不能・例外」を意味する。 */
  status?: number;
  /** `OauthErrorReason` など、閉じた語彙の失敗理由。 */
  reason?: string;
}

/**
 * GBP ドメイン共通のロガー面。`callback.ts` の `GbpCallbackLogger` を引き上げたもので、
 * app.ts の `AppLogger`（error のみ）と同型 + `warn`。実体の注入は index.ts に集約する。
 */
export interface GbpLogger {
  error(message: string, meta?: GbpLogMeta): void;
  warn(message: string, meta?: GbpLogMeta): void;
}

/** ログ・例外メッセージに載せてよい短い識別子だけを通す（機微情報の混入を構造的に防ぐ）。 */
export function safeErrorCode(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'unredactable';
}

export function safeStatus(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'unknown';
}

/** 例外から記録してよいのはコンストラクタ名だけ。message は含めない。 */
export function errorNameOf(error: unknown): string {
  return error instanceof Error ? safeErrorCode(error.name) : typeof error;
}

/**
 * Cloud Logging が解釈できる 1 行 JSON を書き出す。
 * 取り出しは allowlist（上のコメントの理由による）。
 */
export function writeGbpLog(
  level: 'warn' | 'error',
  message: string,
  meta?: GbpLogMeta,
): void {
  const line = JSON.stringify({
    level,
    event: message,
    ...(meta?.flow !== undefined ? { flow: meta.flow } : {}),
    ...(meta?.stage !== undefined ? { stage: meta.stage } : {}),
    ...(meta?.kind !== undefined ? { kind: meta.kind } : {}),
    ...(meta?.ownerId !== undefined ? { ownerId: meta.ownerId } : {}),
    ...(meta?.storeId !== undefined ? { storeId: meta.storeId } : {}),
    ...(meta?.errorKind !== undefined ? { errorKind: meta.errorKind } : {}),
    ...(meta?.errorName !== undefined ? { errorName: meta.errorName } : {}),
    ...(meta?.status !== undefined ? { status: meta.status } : {}),
    ...(meta?.reason !== undefined ? { reason: meta.reason } : {}),
  });
  if (level === 'error') {
    console.error(line);
  } else {
    console.warn(line);
  }
}

/** index.ts から注入する既定の実体。 */
export function createDefaultGbpLogger(): GbpLogger {
  return {
    error: (message, meta) => {
      writeGbpLog('error', message, meta);
    },
    warn: (message, meta) => {
      writeGbpLog('warn', message, meta);
    },
  };
}

// sink は allowlist なので、GbpLogMeta へ項目を足しても取り出しを更新しない限り黙って
// 出力されない。privacy には安全な方向（fail-closed）だが、「新しい診断項目がログに出ない」
// という無音の欠落を再生産する。鍵集合を表明して型で強制する。
// 左辺は名前付き型ではなく **sink の実引数位置** から導く（名前付き型へ固定すると、
// 引数の型を派生型・交差型へ差し替えた瞬間に無言で無効化する）。
type EmittedGbpLogField =
  | 'flow'
  | 'stage'
  | 'kind'
  | 'ownerId'
  | 'storeId'
  | 'errorKind'
  | 'errorName'
  | 'status'
  | 'reason';
type UnemittedGbpLogField = Exclude<
  keyof NonNullable<Parameters<typeof writeGbpLog>[2]>,
  EmittedGbpLogField
>;
const _allGbpLogFieldsEmitted: never = null as unknown as UnemittedGbpLogField;
void _allGbpLogFieldsEmitted;

/**
 * line-webhook の構造化ログ（Issue #230）。
 *
 * survey-web の `src/lib/structured-log.ts` と同型の allowlist（fail-closed）sink である。
 * Cloud Logging が解釈できる 1 行 JSON を出し、`event` 名だけを述語にしてログベース指標
 * （`webhook_signature_failures`）が数える。
 *
 * **`level` で絞られることを期待しないこと。** Cloud Run はアプリが出す `level` フィールドを
 * `LogEntry.severity` へ写さない（本番実測）。指標側の filter に `severity` を足すと 1 件も
 * 一致せず「指標は存在するのに常に 0」という静かな失敗になるため、絞り込みは `event` 名で行う。
 */

export type LogLevel = 'warn' | 'error' | 'info';

/**
 * 署名検証が失敗した理由の区分。
 *
 * **外部から来た値を一切含まない**（我々が名付けた 2 値のいずれか）。ヘッダが無いのか、
 * 有るが一致しないのかは運用上まったく別の意味を持つ:
 * - `missing_header` … LINE 以外からの直接アクセス、あるいは経路の設定事故
 * - `mismatch` … チャネルシークレットの取り違え・再発行、あるいは偽装の試行
 */
export type SignatureFailureReason = 'missing_header' | 'mismatch';

/**
 * ログに載せてよい項目の全集合。
 *
 * **ここへ何を足すかは privacy の判断である。** 署名検証は本文を一切処理する前の境界であり、
 * この時点で手元にある値（raw body・`x-line-signature` の中身・送信元・`line_user_id`）は
 * すべて記録してはいけない側にある（Issue #227「越えてはならない線」）。
 */
export interface WebhookLogFields {
  /** 署名検証失敗の区分。外部由来の値は含まない。 */
  reason?: SignatureFailureReason;
  /**
   * LINE が採番したリクエスト ID（`x-line-request-id`）。障害追跡のキーで、客にも店舗にも紐づかない。
   *
   * `| undefined` を明示するのは exactOptionalPropertyTypes 下での意図の表明である。
   * ヘッダは欠落しうるので「未指定」ではなく「値として undefined」が実際に渡る。
   * 省略可能とだけ書くと、呼び出し側が undefined を渡せず条件分岐で組み立てる羽目になり、
   * 記録するかどうかの判断が sink から呼び出し側へ散らばる。
   */
  requestId?: string | undefined;
}

export type WebhookLogger = (level: LogLevel, event: string, fields?: WebhookLogFields) => void;

/**
 * 署名検証に失敗した（Issue #230）。
 *
 * `error` ではなく `warn` なのは、単発の失敗が異常ではないためである。公開エンドポイントには
 * 無関係なスキャンが日常的に届き、その 1 件ずつに意味は無い。意味を持つのは**率**であり、
 * それを判断するのはアラートポリシー側（5 分あたり 5 件超）の責務である。ここで `error` に
 * すると、正常な背景ノイズがログ上の異常として積み上がり、本物の異常が埋もれる。
 */
export function logSignatureVerificationFailed(
  log: WebhookLogger,
  reason: SignatureFailureReason,
  requestId: string | undefined,
): void {
  log('warn', 'webhook_signature_verification_failed', { reason, requestId });
}

/**
 * Cloud Logging が解釈できる 1 行 JSON を出力する。
 *
 * 出力する項目は sink 側で明示的に取り出す。渡された object をそのまま spread すると、
 * 型検査を通り抜けた余剰プロパティが Cloud Logging へ永続化される。TypeScript の
 * excess property check は「その場で書かれた object literal」にしか適用されず、変数・
 * 関数戻り値・キャスト経由の余剰プロパティは構造的部分型として合法に通るため、
 * **型ではこの経路を塞げない**（survey-web で実測済み・PR #75 レビュー指摘）。
 */
export const writeStructuredLog: WebhookLogger = (level, event, fields) => {
  console[level](
    JSON.stringify({
      level,
      event,
      ...(fields?.reason !== undefined ? { reason: fields.reason } : {}),
      ...(fields?.requestId !== undefined ? { requestId: fields.requestId } : {}),
    }),
  );
};

// 上の sink は allowlist であるため、WebhookLogFields へ項目を足しても取り出しを更新しない
// 限り黙って出力されない。これは privacy には安全な方向（fail-closed）だが、「新しい診断項目が
// ログに出ない」という Issue #62 と同じ状態を再生産する。鍵集合を表明して型で強制する。
// 左辺は名前付き型ではなく **sink の実引数位置** から導く（名前付き型へ固定すると、引数の型を
// 派生型・交差型へ差し替えた瞬間に無言で無効化する）。
type EmittedLogField = 'reason' | 'requestId';
type UnemittedLogField = Exclude<keyof NonNullable<Parameters<WebhookLogger>[2]>, EmittedLogField>;
const _allLogFieldsEmitted: never = null as unknown as UnemittedLogField;
void _allLogFieldsEmitted;

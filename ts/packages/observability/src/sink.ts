/**
 * 記録の出力（Issue #228・タスク 1.4）。
 *
 * 許可された項目を 1 つずつ明示的に取り出して 1 行で書く。**渡された値を展開しない。**
 * 展開すると、型検査を通り抜けた余剰項目（変数経由・キャスト経由で紛れ込んだもの）が
 * そのまま出力される。型だけでは塞げないことは実測済みであり、取り出しの許可制が
 * 実行時の防壁になる。
 */

import type { LogFields, LogLevel, Severity } from './fields.js';

/** 集約基盤が相関識別子として解釈する項目名。 */
const TRACE_KEY = 'logging.googleapis.com/trace';

/** 集約基盤が重大度として解釈する項目名。標準的な `level` は解釈されない。 */
const SEVERITY_KEY = 'severity';

/** 呼び出し側の水準を集約基盤の綴りへ写す。**警告は WARNING であって WARN ではない。** */
const SEVERITY_BY_LEVEL: Readonly<Record<LogLevel, Severity>> = {
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
};

// 署名検証前にも現れる値なので、任意長・任意内容を記録しない。
const LINE_REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** 記録を 1 件書き出す契約。事象名は省略できない。 */
export type Sink = (level: LogLevel, event: string, fields?: LogFields) => void;

/**
 * 鍵集合の表明は**名前付き型ではなく sink の実引数位置から導く**。
 * 名前付き型（`LogFields`）へ固定すると、引数の型を派生型や交差型へ差し替えた瞬間に
 * 表明が無言で無効化する。
 */
type AcceptedFields = NonNullable<Parameters<Sink>[2]>;

/** 集約基盤の特別な名前へ写す項目。通常の取り出しとは別扱いになる。 */
type SpecialField = 'correlationId';

/** そのままの名前で出力する項目。 */
type PlainField = Exclude<keyof AcceptedFields, SpecialField>;

/**
 * 出力する通常項目の一覧。
 *
 * 型へ項目を足してこの一覧を更新し忘れると、**その項目は黙って出力されない**。
 * 「宣言したのに出ない」という #62 と同じ状態になるため、下の表明で型検査を落とす。
 */
const PLAIN_FIELDS = [
  'storeId',
  'errorKind',
  'status',
  'agencyId',
  'lineRequestId',
  'violatedAspects',
  'reason',
  'authorizedCount',
  'currentJstHour',
  'summaryDate',
  'targetsTotal',
  'delivered',
  'failed',
  'skipped',
  'quotaExceeded',
  'quotaExceededStopped',
  'exitCode',
  'activeResources',
  'detail',
  'configKey',
] as const satisfies readonly PlainField[];

// 一覧が通常項目を網羅していることの表明。項目を型へ足して一覧へ足し忘れると、
// `Missing` が never でなくなり、この代入が型エラーになる。
type MissingFromEmitted = Exclude<PlainField, (typeof PLAIN_FIELDS)[number]>;
const _allPlainFieldsEmitted: never = null as unknown as MissingFromEmitted;
void _allPlainFieldsEmitted;

/**
 * 標準出力へ 1 行書く。**いかなる入力に対しても例外を投げない。**
 * 記録できないことを理由に利用者の体験を変えてはならない（要件 3.2 / 3.3）。
 */
export const writeStructuredLog: Sink = (level, event, fields) => {
  const record: Record<string, unknown> = {
    [SEVERITY_KEY]: SEVERITY_BY_LEVEL[level],
    event,
  };

  for (const key of PLAIN_FIELDS) {
    const value = fields?.[key];
    if (value !== undefined) {
      if (
        key === 'lineRequestId' &&
        (typeof value !== 'string' || !LINE_REQUEST_ID_PATTERN.test(value))
      ) {
        continue;
      }
      record[key] = value;
    }
  }

  // 相関識別子は集約基盤が解釈する特別な名前へ写す。
  // **未設定なら項目ごと出さない。** 空文字を出すと集約側が空のトレースとして解釈しうる。
  const correlationId = fields?.correlationId;
  if (correlationId !== undefined) {
    record[TRACE_KEY] = correlationId;
  }

  try {
    // 記録の出力経路として、標準出力への直接の書き込みはここが唯一の許可箇所である
    // （check-log-sink-usage.sh の除外はこのファイルに限定される）。
    console[level](JSON.stringify(record));
  } catch {
    // 出力に失敗しても業務処理へ伝播させない。二次的な記録も試みない（失敗の連鎖を作らない）。
  }
};

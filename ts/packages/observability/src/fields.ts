/**
 * 記録に載せてよい項目の定義（Issue #228・タスク 1.3）。
 *
 * **ここに無い項目は、どこからも出力できない。** 来店客の入力（自由記述・生成された下書き本文・
 * 生成指示）、オーナーを外部プラットフォーム上で一意に識別する値、来店客を複数の記録に
 * またがって同一人物と判定できる値は、**型として持たない**。持たないものは漏れない。
 * プロダクト境界（`.kiro/steering/product.md` の不可侵の前提）を、個々の実装者の注意力では
 * なく構造で守るための定義である。
 *
 * 項目名の正典は `docs/observability/log-field-canon.md`。ここへ項目を足す前に、正典への
 * 登録が先である（`scripts/check-log-field-binding.sh` が両方向で照合する）。
 */

/** 呼び出し側が指定する記録の水準。集約基盤の綴りへの写像は sink が持つ。 */
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * 集約基盤が重大度として解釈する綴り。
 *
 * **警告は `WARNING` であって `WARN` ではない。** 単純な大文字化では `WARN` になり、
 * 集約側が重大度として解釈しないため、重大度で絞り込めなくなる。出力を見ても気づきにくく、
 * 「指標は存在するのに常に 0」という #62 と同型の静かな失敗になる。
 */
export type Severity = 'INFO' | 'WARNING' | 'ERROR';

/**
 * 記録に載せてよい項目の全集合。正典に載る項目をすべて持つ。
 *
 * 例外は種別と状態コードを**平坦な 2 項目**として持ち、入れ子にしない。入れ子にすると
 * 出力鍵が変わり、既存の出力形が崩れる。
 */
export interface LogFields {
  // --- 面をまたいで使う項目 ---

  /** 店舗の識別子。**本番の集計指標がこの名前で参照している**ため改名できない。 */
  readonly storeId?: string;
  /** 例外の種別。有限集合の識別子であり、自由文ではない。**例外の本文は載せない。** */
  readonly errorKind?: string;
  /** 外部呼び出しに由来する状態コード。 */
  readonly status?: number;
  /** 代理店の識別子。どの代理店の操作が失敗したかを特定する。 */
  readonly agencyId?: string;

  // --- 外部プラットフォーム由来の識別子 ---

  /**
   * 外部プラットフォームが付与するリクエストの識別子。
   * 問い合わせに使う業務上の値であり、**利用者を一意に識別する値ではない**。
   */
  readonly lineRequestId?: string;

  // --- 相関識別子 ---

  /**
   * 1 回の操作に属する記録を束ねるための識別子。**値の供給は #229** であり、
   * 本 spec では常に未設定でよい。来店客の識別には用いない。
   */
  readonly correlationId?: string;

  // --- アンケート面 ---

  /** 事後検証で残った未選択観点の識別子。下書き本文・一言・生成指示は載せない。 */
  readonly violatedAspects?: string;

  // --- 店舗詳細面 ---

  /** 店舗ヒントを無視した理由。有限集合の識別子。 */
  readonly reason?: string;
  /** 認可済み店舗の件数。 */
  readonly authorizedCount?: number;

  // --- 配信ジョブ（実行サマリー） ---

  readonly currentJstHour?: number;
  readonly summaryDate?: string;
  readonly targetsTotal?: number;
  readonly delivered?: number;
  readonly failed?: number;
  readonly skipped?: number;
  readonly quotaExceeded?: number;
  readonly quotaExceededStopped?: boolean;
  readonly exitCode?: number;
  /** 終了時に残っていた資源の種別。閉じ忘れの検知に使う。 */
  readonly activeResources?: readonly string[];
  /** 失敗の要約。**`message` という名前は使えない**（集約基盤が本文として吸い、項目検索から消える）。 */
  readonly detail?: string;
  /** 欠落した設定の識別子。自由文ではなく有限集合（環境変数名）である。 */
  readonly configKey?: string;
}

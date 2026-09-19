// 店舗を解決した後のレポートの失敗（design.md「ReportHandler」・Requirements 7.4, 7.5）。
//
// ReportHandler は、対象店舗を決めた後の読み出し・組立・Reply の例外をこの例外に包んで投げ直す。
// エラー境界（app.ts）は、この例外なら店舗名を添えた再試行案内を、そうでなければ汎用の再試行案内を返す。
// 店舗を決める前の例外は包まない（案内に添える店舗名が無い）。
//
// 本文（message）に店舗名を入れない。店舗名は storeName だけで運び、元の例外は cause に残す。
// 記録（ログ）は例外の種別だけを載せるので、店舗名も元の例外の本文も記録へ流れない。

export class StoreScopedReportError extends Error {
  /** 対象店舗の名前（省略しない全文）。再試行案内に添える。 */
  readonly storeName: string;

  constructor(storeName: string, options?: ErrorOptions) {
    super('report failed after the target store was resolved', options);
    this.name = 'StoreScopedReportError';
    this.storeName = storeName;
  }
}

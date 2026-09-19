// レポートの postback 契約（design.md「ReportPostbackCodec」・Requirements 2.3, 2.7）。
//
// 形式は `a=rpt&k=<nr|cmp|tr>[&s=<storeId>][&p=<n>]`。オンボーディング（line-webhook の
// src/onboarding/stages.ts の `a=select|confirm|restart|resume`）と同じ `a=<action>` のキー=値形式に
// 揃え、action の値だけで互いを見分ける。第2フェーズの `a=g_post|g_reply|g_status` とも衝突しない。
// メニューの区画は店舗も頁も持たない形（`a=rpt&k=nr` など）だけを使う。
//
// 形式を変えると、配布済みのメニューとトーク履歴の選択肢が古い data を送り続ける
// （design.md の Revalidation Triggers）。変えるときは張り替えの手順と対にすること。
//
// 実行時の依存を持たない。store-detail のような画面へ同梱されても pg などを持ち込まないよう、
// 他のパッケージを import しない。

export type ReportKind = 'new_reviews' | 'comparison' | 'trend';

export interface ReportRequest {
  readonly kind: ReportKind;
  /** オーナーが選んだ店舗。メニューから来た要求は null。 */
  readonly storeId: string | null;
  /** 店舗の選択肢の頁（0 始まり）。メニューから来た要求は 0。 */
  readonly page: number;
}

/** 導線の文言。メニューのラベルと postback の displayText に使う（要件 2.1 の文言そのもの）。 */
export const REPORT_LABELS: Readonly<Record<ReportKind, string>> = {
  new_reviews: '新着口コミをみる',
  comparison: '競合店との比較をみる',
  trend: '直近の推移を見る',
};

/**
 * 種類の一覧。復号とメニューの判定（menu.ts）が同じ一覧を使う。パッケージの内側だけで使い、
 * index.ts からは公開しない（公開面は design.md の Service Interface に揃える）。
 */
export const REPORT_KINDS: readonly ReportKind[] = ['new_reviews', 'comparison', 'trend'];

// data の上の種類の符号。data は 300 文字に収める必要があるため短い符号にする。
const KIND_CODES: Readonly<Record<ReportKind, string>> = {
  new_reviews: 'nr',
  comparison: 'cmp',
  trend: 'tr',
};

const REPORT_ACTION = 'rpt';

// LINE Messaging API の postback data の上限（references/action-objects.md の Postback Action）。
const MAX_POSTBACK_DATA_LENGTH = 300;

const MAX_STORE_ID_LENGTH = 64;
const MAX_PAGE = 99;

// 頁は 0〜99 の十進数（先頭ゼロは許す。符号・小数・空文字・全角数字は許さない）。
const PAGE_PATTERN = /^\d{1,2}$/;

// 受理する項目の集合。未知の項目や同じ項目の重複を持つ data は、どの値を採るかが曖昧なので受理しない。
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['a', 'k', 's', 'p']);

function isValidStoreId(storeId: string): boolean {
  return storeId.length >= 1 && storeId.length <= MAX_STORE_ID_LENGTH;
}

function kindOfCode(code: string | null): ReportKind | null {
  // 符号の表を添字で引かず、既知の種類を順に照合する。添字で引くと `toString` のような
  // Object のプロトタイプ上の名前が値を返してしまう。
  return REPORT_KINDS.find((kind) => KIND_CODES[kind] === code) ?? null;
}

/**
 * レポートの要求を postback の data にする。
 *
 * 前提条件（storeId は 1〜64 文字、page は 0〜99 の整数）を満たさない要求と、結果が 300 文字を
 * 超える要求は符号化せずに例外を投げる。呼出元が組み立てる値の誤りであり、受け取った LINE の
 * 入力ではないため、黙って丸めない。
 */
export function encodeReportPostback(request: ReportRequest): string {
  if (!REPORT_KINDS.includes(request.kind)) {
    throw new Error('encodeReportPostback: unknown report kind');
  }
  if (request.storeId !== null && !isValidStoreId(request.storeId)) {
    throw new Error(`encodeReportPostback: storeId must be 1-${MAX_STORE_ID_LENGTH} characters`);
  }
  if (!Number.isInteger(request.page) || request.page < 0 || request.page > MAX_PAGE) {
    throw new Error(`encodeReportPostback: page must be an integer between 0 and ${MAX_PAGE}`);
  }

  // 店舗 ID は encodeURIComponent で符号化する。`&` や `=` を含んでも項目の区切りと混ざらず、
  // 復号側の URLSearchParams が元の文字列へ戻す。対になっていないサロゲートを含む値は
  // 往復できないため、encodeURIComponent が URIError を投げる（そのまま呼出元へ伝える）。
  // 頁 0 と店舗なしは項目を省く。メニューの区画の data を `a=rpt&k=<種類>` だけにするため。
  let data = `a=${REPORT_ACTION}&k=${KIND_CODES[request.kind]}`;
  if (request.storeId !== null) {
    data += `&s=${encodeURIComponent(request.storeId)}`;
  }
  if (request.page > 0) {
    data += `&p=${request.page}`;
  }

  // 非 ASCII の店舗 ID は 1 文字が最大 9 文字に膨らむため、文字数の前提だけでは 300 文字に収まらない。
  if (data.length > MAX_POSTBACK_DATA_LENGTH) {
    throw new Error(`encodeReportPostback: encoded data exceeds ${MAX_POSTBACK_DATA_LENGTH} chars`);
  }

  return data;
}

/**
 * postback の data をレポートの要求に戻す。レポートの data でないもの・壊れたものには null を返し、
 * 例外を投げない（data は LINE から届いた外部の入力である）。
 */
export function decodeReportPostback(data: string): ReportRequest | null {
  if (typeof data !== 'string' || data.length === 0 || data.length > MAX_POSTBACK_DATA_LENGTH) {
    return null;
  }

  // オンボーディングの復号と同じ URLSearchParams で読む。文字列からの構築は例外を投げない。
  const params = new URLSearchParams(data);

  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some((key) => !ALLOWED_KEYS.has(key))) {
    return null;
  }

  if (params.get('a') !== REPORT_ACTION) {
    return null;
  }

  const kind = kindOfCode(params.get('k'));
  if (kind === null) {
    return null;
  }

  const storeId = params.get('s');
  if (storeId !== null && !isValidStoreId(storeId)) {
    return null;
  }

  const rawPage = params.get('p');
  if (rawPage !== null && !PAGE_PATTERN.test(rawPage)) {
    return null;
  }

  return { kind, storeId, page: rawPage === null ? 0 : Number(rawPage) };
}

/** レポートの postback として復号できる data か。 */
export function isReportPostbackData(data: string): boolean {
  return decodeReportPostback(data) !== null;
}

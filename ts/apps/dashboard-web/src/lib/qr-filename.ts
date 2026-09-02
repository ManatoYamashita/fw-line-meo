// QR 画像を保存するときのファイル名を決定する純粋関数（Requirements 2.4, 2.5, 2.6）。
//
// サーバは `Content-Disposition: attachment; filename="qr-{storeId}.png"` を付けるが、
// dashboard-api の CORS に exposeHeaders が無いためブラウザからこのヘッダは読めない。
// したがってファイル名の決定はクライアント側の責務になる（design.md 参照）。
//
// このモジュールは DOM・ネットワーク・React のいずれにも依存しない。依存グラフの末端に置く。

// ファイル名として使えない文字（パス区切りと Windows の予約文字）。
const FORBIDDEN_CHARS = new Set(['/', '\\', ':', '*', '?', '"', '<', '>', '|']);

// 制御文字の境界。C0 制御文字（0x00-0x1F）と DEL（0x7F）は文字クラスではなく
// 符号位置で判定する。ソースへ制御文字そのものを書かないための措置。
const C0_UPPER_BOUND = 0x20;
const DEL_CODE_POINT = 0x7f;

// 空白の連なり。1 つの半角空白へ畳む。
const WHITESPACE_RUN = /\s+/g;

// 先頭・末尾に置くと環境によって扱いが揺れる文字（空白と点）。
const EDGE_NOISE = /^[\s.]+|[\s.]+$/g;

// 店名部分の上限（コードポイント単位）。
// 保存先の制約に触れないための保険であり、人が判別できる長さは十分に残る。
const NAME_MAX_CODE_POINTS = 40;

// 同名店舗を区別するために常に付与する店舗 ID の断片の長さ。
const ID_FRAGMENT_LENGTH = 8;

/** ファイル名に残してはならない文字か。 */
function isForbiddenChar(char: string): boolean {
  if (FORBIDDEN_CHARS.has(char)) return true;
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return false;
  return codePoint < C0_UPPER_BOUND || codePoint === DEL_CODE_POINT;
}

/** 店名をファイル名の一部として使える形へ正規化する。使えなくなった場合は空文字を返す。 */
function normalizeStoreName(storeName: string): string {
  // サロゲートペア（絵文字など）を割らないようコードポイント単位で扱う。
  const codePoints = Array.from(storeName).filter((char) => !isForbiddenChar(char));
  const stripped = codePoints.join('').replace(WHITESPACE_RUN, ' ').replace(EDGE_NOISE, '');
  const truncated = Array.from(stripped).slice(0, NAME_MAX_CODE_POINTS).join('');
  // 切り詰めで末尾に空白や点が現れることがあるため、もう一度落とす。
  return truncated.replace(EDGE_NOISE, '');
}

/**
 * 保存ファイル名を決定する。戻り値は常に非空で拡張子 .png を持つ。
 * 形式: `qr-<正規化した店名>-<storeId の先頭 8 文字>.png`
 * 店名が正規化の結果として空になった場合は店名部分を省く。
 */
export function qrFileName(storeName: string, storeId: string): string {
  const idFragment = storeId.slice(0, ID_FRAGMENT_LENGTH);
  const name = normalizeStoreName(storeName);
  // 一覧の絞り込み状態や他店舗の存在に依存させないため、識別子は常に付ける（2.6）。
  return name === '' ? `qr-${idFragment}.png` : `qr-${name}-${idFragment}.png`;
}

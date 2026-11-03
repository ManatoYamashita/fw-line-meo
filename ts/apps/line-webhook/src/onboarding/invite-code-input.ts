// 招待コードの入力の揺れを、照合の前に発行形式（dashboard-api の invite-code-gen.ts・大文字英数 8 字）へ揃える。
//
// **招待コード待ち（await_invite_code）のテキストだけに使う。** 店名検索や GBP の入力には当てない（dispatch で全テキストに
// 当てると店名の全角・空白まで変わる）。照合先（発行形式）と DB（agency_invite_codes.code の大文字小文字を区別する一致）は
// 変えない。失敗回数・ロックの規則も変えない（揃えても一致しなければ、従来どおり失敗に数える）。

/**
 * NFKC 正規化 → 前後の空白を除く → 大文字化。
 * - NFKC: 全角英数（「ＡＢＣ２」）を半角へ。全角スペース（U+3000）・NBSP も半角空白になる。
 * - trim: コピーで付く末尾の改行（\n・\r\n）と前後の空白を除く。中間の空白と、空白でないゼロ幅スペース（U+200B）は残す。
 * - 大文字化: 発行形式は大文字だけなので、小文字で打った入力を同じコードとして扱う。
 */
export function normalizeInviteCodeInput(text: string): string {
  return text.normalize('NFKC').trim().toUpperCase();
}

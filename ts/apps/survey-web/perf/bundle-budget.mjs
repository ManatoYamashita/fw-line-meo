// @ts-check
// 客向けページの転送量予算チェック（ブラウザ不要のローカル近似・Req 2.8 の 3 秒目標の代理）。
// next build 済みの .next/static/chunks から JS と CSS をそれぞれ gzip 合計し、
// どちらかが上限を超えたら非ゼロ終了する。
// フルの Lighthouse（mobile 4G・LCP 3 秒）は CI（Chrome あり）で実施する。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

// 全クライアントチャンクの gzip 上限（客向け /s ページの first-load はこの部分集合）。
const JS_BUDGET_GZIP_BYTES = 300 * 1024;

// 生成 CSS の gzip 上限（Issue #53）。
//
// なぜ CSS にも予算が要るか: Tailwind の生成 CSS は「使ったクラスに比例」して**単調増加**する。
// トークンや部品を足すたびに増えるが、増分は 1 回あたり数百 B と小さく、レビューでは気づかない。
// 実測でも Heading 追加で 6,598 → 7,207 B、その後さらに 7,563 B まで誰にも観測されずに伸びた。
// JS 側の予算（上）は `.js` だけを数えており、この増加を構造的に一度も見ていなかった。
//
// 予算値の根拠: 実測 7,563 B に対し 12 KB（約 1.6 倍の余裕）。Issue #53 の起票時の案は 15 KB
// （約 2 倍）だったが、それでは CSS が倍増するまで無警告で通ってしまい、「歯止め」という
// 本来の目的を満たさない。JS 予算が実測 211 KB に対し 300 KB ＝ 約 1.4 倍で運用できている
// ことに倣い、同程度の比率まで詰めた。部品追加で正当に超えたときは、超過分が妥当かを
// 判断したうえでこの値を更新すること（更新自体が「CSS が増えた」ことの記録になる）。
const CSS_BUDGET_GZIP_BYTES = 12 * 1024;

const chunksDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.next', 'static', 'chunks');

if (!existsSync(chunksDir)) {
  console.error('`.next` が見つかりません。先に `make ts-build`（next build）を実行してください。');
  process.exit(1);
}

// readdirSync は recursive 指定時に string[] | Buffer[] を返すため、filter だけでは
// 要素型が string へ絞られない。実行時に typeof で絞った結果を型の側にも反映する。
const entries = /** @type {string[]} */ (
  readdirSync(chunksDir, { recursive: true }).filter((f) => typeof f === 'string')
);

/**
 * 指定拡張子のファイルを gzip 合計する。
 * @param {string} extension
 * @returns {{ count: number, gzipBytes: number }}
 */
function totalGzipFor(extension) {
  const files = entries.filter((f) => f.endsWith(extension));
  let gzipBytes = 0;
  for (const f of files) {
    gzipBytes += gzipSync(readFileSync(path.join(chunksDir, f))).length;
  }
  return { count: files.length, gzipBytes };
}

/** @param {number} n */
const kb = (n) => (n / 1024).toFixed(1);

const js = totalGzipFor('.js');
const css = totalGzipFor('.css');

console.log(
  `client JS  (gzip, ${js.count} chunks): ${kb(js.gzipBytes)} KB / budget ${kb(JS_BUDGET_GZIP_BYTES)} KB`,
);
console.log(
  `client CSS (gzip, ${css.count} files):  ${kb(css.gzipBytes)} KB / budget ${kb(CSS_BUDGET_GZIP_BYTES)} KB`,
);

let exceeded = false;

if (js.gzipBytes > JS_BUDGET_GZIP_BYTES) {
  console.error('JS バンドル予算を超過しました。');
  exceeded = true;
}

// 0 件は「予算内」ではなく「測れていない」。next build の出力先が変われば
// このガードは黙って 0 B を報告し、CSS がどれだけ増えても永久に緑になる
// （Issue #53 が問題にした「歯止めが無い」状態へ、検出されずに戻る）。
if (css.count === 0) {
  console.error(
    'CSS が 1 件も見つかりません。next build の出力先が変わった可能性があります（予算検査が空振りしています）。',
  );
  exceeded = true;
} else if (css.gzipBytes > CSS_BUDGET_GZIP_BYTES) {
  console.error('CSS 予算を超過しました。');
  exceeded = true;
}

if (exceeded) {
  process.exit(1);
}
console.log('bundle budget OK');

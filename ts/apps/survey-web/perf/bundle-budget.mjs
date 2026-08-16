// @ts-check
// 客向けページの JS 転送量予算チェック（ブラウザ不要のローカル近似・Req 2.8 の 3 秒目標の代理）。
// next build 済みの .next/static/chunks の全 JS を gzip 合計し、上限を超えたら非ゼロ終了。
// フルの Lighthouse（mobile 4G・LCP 3 秒）は CI（Chrome あり）で実施する。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

// 全クライアントチャンクの gzip 上限（客向け /s ページの first-load はこの部分集合）。
const BUDGET_GZIP_BYTES = 300 * 1024;

const chunksDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.next', 'static', 'chunks');

if (!existsSync(chunksDir)) {
  console.error('`.next` が見つかりません。先に `make ts-build`（next build）を実行してください。');
  process.exit(1);
}

// readdirSync は recursive 指定時に string[] | Buffer[] を返すため、filter だけでは
// 要素型が string へ絞られない。実行時に typeof で絞った結果を型の側にも反映する。
const jsFiles = /** @type {string[]} */ (
  readdirSync(chunksDir, { recursive: true }).filter(
    (f) => typeof f === 'string' && f.endsWith('.js'),
  )
);

let totalGzip = 0;
for (const f of jsFiles) {
  totalGzip += gzipSync(readFileSync(path.join(chunksDir, f))).length;
}

/** @param {number} n */
const kb = (n) => (n / 1024).toFixed(1);
console.log(`client JS (gzip, all chunks): ${kb(totalGzip)} KB / budget ${kb(BUDGET_GZIP_BYTES)} KB`);

if (totalGzip > BUDGET_GZIP_BYTES) {
  console.error('JS バンドル予算を超過しました。');
  process.exit(1);
}
console.log('bundle budget OK');

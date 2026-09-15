// @ts-check
// Lighthouse が測った画面が、E2E の確定店舗の回答画面であることを確かめる CLI（Issue #264）。
// 判定の中身は lhr-verification.mjs にある。CI（ts-ci の lighthouse ジョブ）とローカルの実行装置
// （scripts/run-e2e-local.sh）が、どちらもこのファイルを呼ぶ。
//
//   node perf/verify-lhr.mjs                # lhci autorun の後に .lighthouseci/lhr-*.json を判定する
//   node perf/verify-lhr.mjs --print-seed   # seed の店舗を `<id>\t<店名>` で出す
//
// 直接実行されたかどうかを判定する形（import.meta.url と argv[1] の比較）は使わない。
// シンボリックリンク越しに起動すると判定が外れ、本体が一度も走らないまま exit 0 で抜けるため、
// 何も確かめずに緑を返すことになる。このファイルは main を呼ぶことだけを持つ。
// process.exit ではなく exitCode を使うのは、パイプへの出力を書き切ってから終わるためである。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './lhr-verification.mjs';

const surveyDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.exitCode = main({ surveyDir, argv: process.argv.slice(2) });

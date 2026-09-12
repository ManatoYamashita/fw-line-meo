#!/usr/bin/env bash
# 例外の握り潰しガード（Issue #233）。
#
# catch の本体がコメントだけ（または空）だと、例外を観測可能な結果へ変換せずに
# 消している。これは「処理は成功したが補助処理だけ失敗した」設計とは別物であり、
# 失敗の事実すら残らないため、運用上の観測値を壊す。
#
# 文字列検索だけでは文字列リテラルやコメント中の catch に誤爆するため、Node の字句走査で
# catch の本体を特定する。対象は git 管理下の実行時コードだけで、test / e2e / scripts は
# 含めない。例外を吸収する必要がある場合は、本体内に次の注釈と理由を残すこと:
#   // swallowed-exception: intentional — <理由>
# 注釈は無条件の除外ではなく、理由が空なら赤にする。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! git -C "$ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "ERROR: リポジトリのルートを git work tree として解決できません。" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: 例外の握り潰しガードには node が必要です。" >&2
  exit 1
fi

node - "$ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const root = process.argv[2];
const extensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const files = cp
  .execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'ts/apps'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => {
    const ext = path.extname(file);
    return extensions.has(ext) && (file.includes('/src/') || file.includes('/app/'));
  });

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function isIdentifierChar(char) {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function skipQuoted(source, start, quote) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

function skipComment(source, start) {
  if (source.startsWith('//', start)) {
    const end = source.indexOf('\n', start + 2);
    return end === -1 ? source.length : end;
  }
  const end = source.indexOf('*/', start + 2);
  return end === -1 ? source.length : end + 2;
}

function findBodyEnd(source, open) {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    if (source.startsWith('//', i) || source.startsWith('/*', i)) {
      i = skipComment(source, i);
      continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      i = skipQuoted(source, i, quote);
      continue;
    }
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function stripCommentsAndWhitespace(body) {
  let result = '';
  let i = 0;
  while (i < body.length) {
    if (body.startsWith('//', i) || body.startsWith('/*', i)) {
      i = skipComment(body, i);
      continue;
    }
    const quote = body[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      const end = skipQuoted(body, i, quote);
      result += body.slice(i, end);
      i = end;
      continue;
    }
    if (!/\s/.test(body[i])) result += body[i];
    i += 1;
  }
  return result;
}

const violations = [];
for (const relative of files) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('//', i) || source.startsWith('/*', i)) {
      i = skipComment(source, i);
      continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      i = skipQuoted(source, i, quote);
      continue;
    }
    if (
      source.startsWith('catch', i) &&
      !isIdentifierChar(source[i - 1]) &&
      !isIdentifierChar(source[i + 5])
    ) {
      let cursor = i + 5;
      while (/\s/.test(source[cursor] ?? '')) cursor += 1;
      if (source[cursor] === '(') {
        let parenDepth = 0;
        do {
          if (source[cursor] === '(') parenDepth += 1;
          if (source[cursor] === ')') parenDepth -= 1;
          cursor += 1;
        } while (cursor < source.length && parenDepth > 0);
        while (/\s/.test(source[cursor] ?? '')) cursor += 1;
      }
      if (source[cursor] === '{') {
        const end = findBodyEnd(source, cursor);
        if (end === -1) {
          console.error(`ERROR: ${relative}:${lineOf(source, cursor)} の catch 本体を解析できません。`);
          process.exitCode = 1;
          break;
        }
        const body = source.slice(cursor + 1, end);
        const normalized = stripCommentsAndWhitespace(body);
        const hasIntentionalMarker = /swallowed-exception:\s*intentional\b/.test(body);
        const intentional = /swallowed-exception:\s*intentional\s*—\s*\S/.test(body);
        if (normalized.length === 0 && hasIntentionalMarker && !intentional) {
          violations.push(`${relative}:${lineOf(source, i)}: 例外吸収の注釈に理由がありません。`);
        } else if (normalized.length === 0 && !intentional) {
          violations.push(`${relative}:${lineOf(source, i)}: 空の catch が例外を握り潰しています。共有ロガーで記録するか、理由付きの swallowed-exception: intentional 注釈を付けてください。`);
        }
        i = end + 1;
        continue;
      }
    }
    i += 1;
  }
}

if (violations.length > 0) {
  for (const violation of violations) console.error(`ERROR: ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`OK: 実行時コード ${files.length} ファイルの空 catch を検査しました。`);
}
NODE

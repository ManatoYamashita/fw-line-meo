// @ts-check
// ローカル確認用の LINE ID トークン検証の偽物（Issue #437）。**本番では使わない・どこからも import しない。**
//
// 店舗詳細とアンケート設定は、ID トークンを LINE の `POST /oauth2/v2.1/verify` で検証して sub を得る。ローカルの
// ブラウザでは本物の ID トークンを得られないので、既存の 2 つの差し替え口を組み合わせて画面を開く:
//   1. `E2E_STUB_IDP=1` でビルドすると、`@line/liff` が e2e/stubs/liff.ts に差し替わり、固定のトークンを返す
//      （出荷経路へ漏れないことは scripts/check-e2e-idp-stub-isolation.sh が機械強制する）。
//   2. サーバーの `LIFF_VERIFY_ENDPOINT`（本番は未設定・テスト用）をこのサーバーへ向けると、検証の応答が
//      ここから返る。トークンの中身は見ず、起動時に渡した sub を返す。
// どちらも本番の設定では効かない。アプリのコードに認証を迂回する経路は足していない。
//
// 使い方（ローカルのみ）:
//   node ts/apps/store-detail/e2e/stubs/liff-verify-server.mjs --sub U-e2e --port 3199
//   → http://127.0.0.1:3199 が { sub } を返す。sub は DB の owners.line_user_id と一致させる
//     （ts/apps/survey-web/e2e/seed.sql の owner は U-e2e）。
// 127.0.0.1 だけで待ち受ける（外部から到達させない）。

import { createServer } from 'node:http';

/**
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

const sub = arg('sub', 'U-e2e');
const port = Number(arg('port', '3199'));

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ iss: 'https://access.line.me', sub, aud: 'local-preview' }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`LINE ID トークン検証の偽物: http://127.0.0.1:${port}（sub=${sub}・ローカル確認専用）`);
});

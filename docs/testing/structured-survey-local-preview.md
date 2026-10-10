# structured survey のローカル確認手順

店舗詳細の「アンケート設定」（Issue #437）で料理名を登録し、その料理が客向けの新しいアンケート（Issue #438）に出て、選んで送信できるまでを、自分のブラウザで確かめる手順である。
**本番の認証の迂回は使わない。** 使うのは E2E と同じ 2 つの差し替え口だけで、どちらも本番の設定では効かない。

- `E2E_STUB_IDP=1` で店舗詳細をビルドすると、`@line/liff` がスタブに差し替わり、固定の ID トークンを返す（出荷経路へ漏れないことは `scripts/check-e2e-idp-stub-isolation.sh` が機械強制する）。
- 店舗詳細のサーバーの `LIFF_VERIFY_ENDPOINT`（本番では未設定）を、ローカルの偽の検証サーバー（`ts/apps/store-detail/e2e/stubs/liff-verify-server.mjs`）へ向ける。偽物は固定の sub（`U-e2e`）を返す。

structured survey の有効化は、店舗オーナーの操作には無い（客向けの新しいアンケートの下書き生成は Issue #439 で作る）。ローカルでは `ts/apps/survey-web/e2e/structured-seed.sql` が、E2E と同じく fixture として 1 店舗だけ有効にする。

## 1. 必要なもの

- PostgreSQL 15 以上（ローカルで起動しておく）。例: Docker Desktop なら `docker run -d -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16`
- `psql` と Node.js 24 と pnpm
- 以下のコマンドは Windows の Git Bash でリポジトリのルートから実行する

## 2. DB を作り、migration と seed を当てる

```bash
export DATABASE_URL=postgres://postgres@localhost:5432/fwlm_preview
psql postgres://postgres@localhost:5432/postgres -c "DROP DATABASE IF EXISTS fwlm_preview" -c "CREATE DATABASE fwlm_preview"
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"; done
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ts/apps/survey-web/e2e/seed.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ts/apps/survey-web/e2e/structured-seed.sql
```

seed のオーナー（sub `U-e2e`）は 2 店舗を持つ。

| 店舗 | 種類 | 客向けアンケートの URL |
|---|---|---|
| スターバックス コーヒー リザーブ ロースタリー 東京 | legacy（従来のアンケート） | `http://127.0.0.1:3100/s/44444444-4444-4444-4444-444444444444` |
| 海鮮酒場 うみのて（構造化アンケート） | structured（新しいアンケート） | `http://127.0.0.1:3100/s/55555555-5555-4555-8555-555555555555` |

## 3. 依存とビルド

```bash
pnpm -C ts install
pnpm -C ts run build
# 店舗詳細だけは LIFF をスタブへ差し替えたビルドにする（確認が終わったら 6. で戻す）
E2E_STUB_IDP=1 NEXT_PUBLIC_LIFF_ID=local-preview pnpm -C ts --filter @fwlm/store-detail run build
```

## 4. 3 つのプロセスを起動する（ターミナルを 3 つ使う）

```bash
# (A) 偽の LINE ID トークン検証サーバー（127.0.0.1:3199）
node ts/apps/store-detail/e2e/stubs/liff-verify-server.mjs --sub U-e2e --port 3199

# (B) 店舗詳細（127.0.0.1:3121）
DATABASE_URL=postgres://postgres@localhost:5432/fwlm_preview LIFF_CHANNEL_ID=local-preview \
  LIFF_VERIFY_ENDPOINT=http://127.0.0.1:3199 PORT=3121 pnpm -C ts --filter @fwlm/store-detail start

# (C) 客向けアンケート（127.0.0.1:3100）。legacy の下書き生成は Gemini をモックする（E2E と同じ）
DATABASE_URL=postgres://postgres@localhost:5432/fwlm_preview SESSION_SIGNING_KEY=local-preview-signing-key \
  GEMINI_API_KEY=local-preview-dummy-key \
  NODE_OPTIONS="--import file:///$(cygpath -m "$PWD/ts/apps/survey-web/e2e/mock-gemini.mjs")" \
  PORT=3100 pnpm -C ts --filter @fwlm/survey-web start
```

## 5. 試す

ブラウザの開発者ツールで携帯の幅（例: Pixel 5）にすると、実機に近い表示になる。

1. 店舗詳細 `http://127.0.0.1:3121/store` を開き、「海鮮酒場 うみのて（構造化アンケート）」を選ぶ。
2. 「アンケート設定」を開く（直接なら `http://127.0.0.1:3121/store/survey-settings?storeId=55555555-5555-4555-8555-555555555555`）。
3. 「料理名を追加」に料理名（例: 名物もつ煮）を入れて「追加する」。並び替え・名前の変更・非表示・予約・来店の表示も試せる。
4. 客向けアンケート `http://127.0.0.1:3100/s/55555555-5555-4555-8555-555555555555` を開く（設定を変えた後は再読み込みする）。
5. 星を選び、「良かったところ」の「料理」を開くと、登録した料理が「具体的な料理」に出る。料理を選び、「〇〇について」の「味」などを選ぶ。
6. 「気になったところ」も同じように選べる（同じ料理・同じ項目を選んでもよい）。一言は任意。
7. 「送信する」で、回答済みの画面（Google のクチコミを書く）へ進む。structured の回答の下書きは、まだ作らない（Issue #439）。

同じ端末で回答すると、その店舗は回答済みの画面になる。もう一度試すときは、ブラウザの localStorage を消すか、シークレットウィンドウを使う。

アンケートを開いたまま店舗設定を変えて送信すると、「アンケート内容が更新されました。ページを再読み込みして、もう一度回答してください。」と案内される（古い画面の回答は受け付けない）。

## 6. 片付け

```bash
# 店舗詳細を通常のビルドへ戻す（スタブ入りのビルドを残さない）
pnpm -C ts --filter @fwlm/store-detail run build
```

# structured survey のローカル確認手順

店舗詳細の「アンケート設定」（Issue #437）で料理名を登録し、その料理が客向けの新しいアンケート（Issue #438）に出て、選んで送信できるまでを、自分のブラウザで確かめる手順である。
**本番の認証の迂回は使わない。** 使うのは E2E と同じ 2 つの差し替え口だけで、どちらも本番の設定では効かない。

- `E2E_STUB_IDP=1` で店舗詳細をビルドすると、`@line/liff` がスタブに差し替わり、固定の ID トークンを返す（出荷経路へ漏れないことは `scripts/check-e2e-idp-stub-isolation.sh` が機械強制する）。
- 店舗詳細のサーバーの `LIFF_VERIFY_ENDPOINT`（本番では未設定）を、ローカルの偽の検証サーバー（`ts/apps/store-detail/e2e/stubs/liff-verify-server.mjs`）へ向ける。偽物は固定の sub（`U-e2e`）を返す。

structured survey の有効化は、店舗オーナーの操作には無い（structured の回答の下書きは Issue #439 の通常生成＝Natural LLM Realizer が作り、失格が続いたときだけ safe fallback を返す）。ローカルでは `ts/apps/survey-web/e2e/structured-seed.sql` が、E2E と同じく fixture として 1 店舗だけ有効にする。

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

# (C) 客向けアンケート（127.0.0.1:3100）。下書き生成（legacy と structured の両方）は Gemini をモックする（E2E と同じ）
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
7. 「送信する」で、下書きの画面（「コピーして投稿する」・Google のクチコミを書く・別の文章を生成）へ進む。下書きはモックが回答の claim から組み立てた文（「刺身盛り合わせの味が良かったです。」の形）で、hard gate を通った LLM の経路を通ったことを示す。safe fallback に落ちたときは「刺身盛り合わせは味が良かったです。」の形になる。星だけ・開いて閉じただけの回答は claim が無いので、従来どおり回答済みの画面（Google のクチコミを書く）へ進む。

   実 Gemini の文を見るときは、下の「5.1 実 Gemini で自然さを確かめる」の手順で (C) を起動し直す。

### 5.1 実 Gemini で自然さを確かめる（5 ケース）

通常生成の方針（新しい具体的事実は作らないが、回答から自然に導ける言い換え・弱い主観は許す・`ts/apps/survey-web/eval/README.md` の「生成の方針」）が効いているかを目で確かめる。使うのは **自分の開発用の `GEMINI_API_KEY`** で、本番のシークレットは使わない（課金が発生する）。キーは入力を表示しないプロンプトで受け、(C) のプロセスの環境にだけ渡す（ファイル・シェル履歴へ残さない）。

```bash
# (C') 客向けアンケートを実 Gemini で起動する（(C) の代わり・Git Bash）
read -rsp 'GEMINI_API_KEY: ' GEMINI_API_KEY; echo
DATABASE_URL=postgres://postgres@localhost:5432/fwlm_preview SESSION_SIGNING_KEY=local-preview-signing-key   GEMINI_API_KEY="$GEMINI_API_KEY" PORT=3100 pnpm -C ts --filter @fwlm/survey-web start
unset GEMINI_API_KEY
```

`http://127.0.0.1:3100/s/55555555-5555-4555-8555-555555555555` で、次の 5 ケースを回答する（1 ケースごとにシークレットウィンドウを開き直すか localStorage を消す）。「別の文章を生成」で同じ回答から何本か出し、言い回しが変わることも見る。

| # | 良かったところ | 気になったところ | 見るところ |
|---|---|---|---|
| 1 | 料理 → 量／接客・提供 → 接客の丁寧さ | 予約・来店 → 入店までの待ち時間 | 「入店までの待ち時間が気になりましたが、料理の量は満足できました。接客は丁寧でした。」のような項目の読み上げより自然か |
| 2 | 料理 → 刺身盛り合わせ → 味 | — | 「おいしかった」程度の言い換えで、新鮮・脂などの描写を足していないか |
| 3 | 料理 → 刺身盛り合わせ → 味・見た目 | — | 味と見た目を 1 文にまとめるなど、2 項目を並べ読みしていないか |
| 4 | 料理 → 刺身盛り合わせ → 味 | 接客・提供 → 料理・ドリンクの提供 | 提供について、時間（「20分」）や原因（混雑）を作っていないか |
| 5 | 料理 → 刺身盛り合わせ → 味 | 料理 → 刺身盛り合わせ → 味（exact overlap） | 「良かった点もあり、気になる点もありました」の範囲か。「最初は良かったが後半は…」のような理由を作っていないか |
| 6 | 予約・来店 → 予約のしやすさ／接客・提供 → 接客の丁寧さ／料理 → 量（★5） | ドリンク → 種類 | 最初の 1 本と「別の文章を生成」3 回の計 4 本で、項目の順番・文の数・まとめ方が変わるか（語尾だけの違いでないか） |

ケース 6 で見ること: (1)「満足できる内容」「満足できるもの」が出ない (2)「全体として〜」が毎回は付かない (3) 4 本で構成が違う (4)「〜だったよ」のような友達口調に戻っていない (5) 回答に無い具体的な事実（時間・原因・人数など）が無い (6) safe fallback（羅列の文）に落ちていない。

safe fallback の文（「刺身盛り合わせは味が良かったです。」の形・羅列）が出たら、通常生成が 2 回とも失格になったか生成に失敗したことを示す。サーバーのログ（`survey-web.structured_draft_retry` / `survey-web.structured_draft_fallback`）に、失格の種類と claim の件数だけが残る（下書き・一言・料理名は残らない）。

同じ端末で回答すると、その店舗は回答済みの画面になる。もう一度試すときは、ブラウザの localStorage を消すか、シークレットウィンドウを使う。

アンケートを開いたまま店舗設定を変えて送信すると、「アンケート内容が更新されました。ページを再読み込みして、もう一度回答してください。」と案内される（古い画面の回答は受け付けない）。

## 6. 片付け

```bash
# 店舗詳細を通常のビルドへ戻す（スタブ入りのビルドを残さない）
pnpm -C ts --filter @fwlm/store-detail run build
```

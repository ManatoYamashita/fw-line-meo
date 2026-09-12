# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-log-field-canon.sh の自己テスト（Issue #228 タスク 2.1）。
#
# 対象は表の構造検証のみで実行環境に依存しないため、skip 条件を持たない。
#
# 本ガードは正典**だけ**を読む。実装との突き合わせは check-log-field-binding.sh の担当であり、
# 分離は意図的である（前者は移送の前から緑にでき、後者は移送が終わるまで赤であることに意味がある）。

# 最小の正典。項目 2 行（既存 1・新規 1）と事象 1 行を持つ。
lfc_canon() {
  fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 店舗の識別子 | `storeId` | `store_id` | 既存 | `ts/packages/observability/src/fields.ts` | 変更禁止 |
| 相関識別子 | `logging.googleapis.com/trace` | 該当なし | 新規 | `ts/packages/observability/src/sink.ts` | 値の供給は別課題 |
| 重大度 | `severity` | `severity` | 新規 | `ts/packages/observability/src/sink.ts` | 集約基盤の特別項目 |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `survey_page_viewed` | survey-web | 既存 | `ts/apps/survey-web/src/lib/structured-log.ts` | 変更禁止 |
EOF
}

t_begin 'check-log-field-canon: 整った正典に対して緑'
fx_guard check-log-field-canon
lfc_canon
fx_run check-log-field-canon
expect_green
expect_output_matches '項目 3 行 / 事象 1 行'
t_end

t_begin 'check-log-field-canon: 相関識別子の行を削ると赤'
fx_guard check-log-field-canon
# 相関識別子は #229 が値を入れる受け皿である。行ごと消えると
# 「用意したはずの器が無い」ことに誰も気づけない。
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 店舗の識別子 | `storeId` | `store_id` | 既存 | `ts/packages/observability/src/fields.ts` | 変更禁止 |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `survey_page_viewed` | survey-web | 既存 | `ts/apps/survey-web/src/lib/structured-log.ts` | 変更禁止 |
EOF
fx_run check-log-field-canon
expect_red '「相関識別子」の行がありません'
t_end

t_begin 'check-log-field-canon: 新規の項目を実行面ごとに別名にすると赤'
fx_guard check-log-field-canon
# 既存の分岐は固定したまま、前方だけ統一する（要件 4.5）。
# 新規の行が面ごとに別名だと、分岐が今後も増え続ける。
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 相関識別子 | `logging.googleapis.com/trace` | 該当なし | 新規 | `ts/packages/observability/src/sink.ts` | 値の供給は別課題 |
| 重大度 | `severity` | `severityLevel` | 新規 | `ts/packages/observability/src/sink.ts` | 面ごとに別名 |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `survey_page_viewed` | survey-web | 既存 | `ts/apps/survey-web/src/lib/structured-log.ts` | 変更禁止 |
EOF
fx_run check-log-field-canon
expect_red '実行面ごとに別名で登録されています'
t_end

t_begin 'check-log-field-canon: 既存の項目が面ごとに別名でも赤にしない'
fx_guard check-log-field-canon
# storeId / store_id は本番の集計指標と既存 spec がそれぞれ固定しており、
# **統一できないことが正しい**。ここを赤にすると正典が成立しない。
lfc_canon
fx_run check-log-field-canon
expect_green
expect_absent '実行面ごとに別名で登録されています'
t_end

t_begin 'check-log-field-canon: 該当のない欄を空にすると赤'
fx_guard check-log-field-canon
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 相関識別子 | `logging.googleapis.com/trace` |  | 新規 | `ts/packages/observability/src/sink.ts` | 日次バッチ層の欄が空 |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `survey_page_viewed` | survey-web | 既存 | `ts/apps/survey-web/src/lib/structured-log.ts` | 変更禁止 |
EOF
fx_run check-log-field-canon
expect_red '空欄があります'
t_end

t_begin 'check-log-field-canon: 由来が 2 値でないと赤'
fx_guard check-log-field-canon
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 相関識別子 | `logging.googleapis.com/trace` | 該当なし | たぶん新規 | `ts/packages/observability/src/sink.ts` | 由来が 2 値でない |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `survey_page_viewed` | survey-web | 既存 | `ts/apps/survey-web/src/lib/structured-log.ts` | 変更禁止 |
EOF
fx_run check-log-field-canon
expect_red '「既存」か「新規」であるべきです'
t_end

t_begin 'check-log-field-canon: ヘッダが変われば 0 件で緑を返さない（空振り防止）'
fx_guard check-log-field-canon
# 抽出はヘッダの完全一致に依存する。列を足したり改名したりすると
# **全件を取りこぼしても 0 件＝緑** になりうる。
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 | 追加列 |
|---|---|---|---|---|---|---|
| 相関識別子 | `logging.googleapis.com/trace` | 該当なし | 新規 | `ts/packages/observability/src/sink.ts` | | |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `survey_page_viewed` | survey-web | 既存 | `ts/apps/survey-web/src/lib/structured-log.ts` | 変更禁止 |
EOF
fx_run check-log-field-canon
expect_red '1 行も抽出できませんでした'
t_end

t_begin 'check-log-field-canon: 正典が存在しなければ赤'
fx_guard check-log-field-canon
fx_run check-log-field-canon
expect_red 'がありません'
t_end

# ---------------------------------------------------------------------------
# 独立検証（2026-09-09）で「ガード本体へ変異を当てても落ちない」と指摘された分岐を固定する。
# 事象名の表の検証は、ケースが常に整った 1 行しか持たなかったため丸ごと空いていた。

t_begin 'check-log-field-canon: 事象名の表の列数不足を検出する'
fx_guard check-log-field-canon
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 相関識別子 | `correlationId` | 該当なし | 新規 | `ts/packages/observability/src/sink.ts` | 受け皿 |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `demo.started` | demo | 既存 |
EOF
fx_run check-log-field-canon
expect_red '事象名の表に列数'
t_end

t_begin 'check-log-field-canon: 事象名の表の空欄を検出する'
fx_guard check-log-field-canon
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 相関識別子 | `correlationId` | 該当なし | 新規 | `ts/packages/observability/src/sink.ts` | 受け皿 |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `demo.started` |  | 既存 | `ts/apps/demo/src/log.ts` | 実行面が空 |
EOF
fx_run check-log-field-canon
expect_red '事象名の表に空欄があります'
t_end

t_begin 'check-log-field-canon: 事象名の表の由来が 2 値でないと赤'
fx_guard check-log-field-canon
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 相関識別子 | `correlationId` | 該当なし | 新規 | `ts/packages/observability/src/sink.ts` | 受け皿 |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `demo.started` | demo | たぶん既存 | `ts/apps/demo/src/log.ts` | 由来が 2 値でない |
EOF
fx_run check-log-field-canon
expect_red '「既存」か「新規」であるべきです'
t_end

t_begin 'check-log-field-canon: 事象名の表が空でも緑を返さない（空振り防止）'
fx_guard check-log-field-canon
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 相関識別子 | `correlationId` | 該当なし | 新規 | `ts/packages/observability/src/sink.ts` | 受け皿 |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 | 追加列 |
|---|---|---|---|---|---|
| `demo.started` | demo | 既存 | `ts/apps/demo/src/log.ts` | | |
EOF
fx_run check-log-field-canon
expect_red '事象名の表から 1 行も抽出できませんでした'
t_end

t_begin 'check-log-field-canon: 項目名の表の列数不足を検出する'
fx_guard check-log-field-canon
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 相関識別子 | `correlationId` | 該当なし | 新規 |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `demo.started` | demo | 既存 | `ts/apps/demo/src/log.ts` | |
EOF
fx_run check-log-field-canon
expect_red '項目名の表に列数'
t_end

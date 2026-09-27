# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-log-field-binding.sh の自己テスト（Issue #228 タスク 2.2）。
#
# 対象は正典と実装の突き合わせのみで実行環境に依存しないため、skip 条件を持たない。
#
# 本ガードは**移送が完了するまで実ツリーに対して赤である**。それが正しく、その赤が移送すべき
# 対象の一覧になる。自己テストは fixture の上で「揃っていれば緑・欠ければ赤」を固定する。

# 正典と実装が揃った最小構成。
lfb_fixture() {
  fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 店舗の識別子 | `storeId` | `store_id` | 既存 | `ts/packages/observability/src/fields.ts` ／ `go/internal/demo/log.go` | 変更禁止 |
| 相関識別子 | `correlationId` | 該当なし | 新規 | `ts/packages/observability/src/fields.ts` | 出力時は別名へ写す |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `demo.started` | demo | 既存 | `ts/apps/demo/src/log.ts` | |
EOF
  fx_write ts/packages/observability/src/fields.ts <<'EOF'
export interface LogFields {
  readonly storeId?: string;
  readonly correlationId?: string;
}
EOF
  fx_write ts/apps/demo/src/log.ts <<'EOF'
import { writeStructuredLog } from '@fwlm/observability';

export const STORE_KEY = 'storeId';

export function run(): void {
  writeStructuredLog('info', 'demo.started', { storeId: 'store-1' });
}
EOF
  fx_write go/internal/demo/log.go <<'EOF'
package demo

const StoreIDKey = "store_id"
EOF
}

t_begin 'check-log-field-binding: 正典と実装が揃っていれば緑'
fx_guard check-log-field-binding
lfb_fixture
fx_run check-log-field-binding
expect_green
expect_output_matches '出典 4 件 / 型の項目 2 件 / 実装の事象名 1 件'
t_end

t_begin 'check-log-field-binding: 出典が実在しないと赤'
fx_guard check-log-field-binding
lfb_fixture
rm -f "${FX}/ts/apps/demo/src/log.ts"
fx_run check-log-field-binding
expect_red 'が実在しません'
t_end

t_begin 'check-log-field-binding: 出典に項目名が現れないと赤'
fx_guard check-log-field-binding
lfb_fixture
# 型定義から storeId の宣言を消す（正典は宣言したままなので乖離する）。
fx_write ts/packages/observability/src/fields.ts <<'EOF'
export interface LogFields {
  readonly correlationId?: string;
}
EOF
fx_run check-log-field-binding
expect_red '項目名「storeId」が現れません'
t_end

t_begin 'check-log-field-binding: 出典に事象名が現れないと赤'
fx_guard check-log-field-binding
lfb_fixture
fx_write ts/apps/demo/src/log.ts <<'EOF'
import { writeStructuredLog } from '@fwlm/observability';

export const STORE_KEY = 'storeId';

export function run(): void {
  writeStructuredLog('info', 'demo.other', { storeId: 'store-1' });
}
EOF
fx_run check-log-field-binding
expect_red '事象名「demo.started」が現れません'
t_end

t_begin 'check-log-field-binding: 型にあるのに正典へ無い項目を検出する（逆方向）'
fx_guard check-log-field-binding
lfb_fixture
# 実装が先行した状態。正典への登録が先である。
fx_write ts/packages/observability/src/fields.ts <<'EOF'
export interface LogFields {
  readonly storeId?: string;
  readonly correlationId?: string;
  readonly undeclaredField?: string;
}
EOF
fx_run check-log-field-binding
expect_red '正典の応答層の列に登録されていません'
t_end

# ---------------------------------------------------------------------------
# 偽陰性の防止（実測して塞いだ軸）

t_begin 'check-log-field-binding: 別語の一部に当たっても緑にしない'
fx_guard check-log-field-binding
lfb_fixture
# 正典へ detail を足すが、出典には `store-detail` というコメントしか置かない。
# 素朴な部分一致だと通ってしまう（実ツリーで実測した偽陰性。コメント中の
# `store-detail` が項目名 `detail` にマッチして緑になっていた）。
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 相関識別子 | `correlationId` | 該当なし | 新規 | `ts/packages/observability/src/fields.ts` | 出力時は別名へ写す |
| 失敗の要約 | `detail` | 該当なし | 新規 | `ts/apps/demo/src/log.ts` | 別語に当たらないこと |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `demo.started` | demo | 既存 | `ts/apps/demo/src/log.ts` | |
EOF
fx_write ts/packages/observability/src/fields.ts <<'EOF'
export interface LogFields {
  readonly correlationId?: string;
}
EOF
fx_write ts/apps/demo/src/log.ts <<'EOF'
import { writeStructuredLog } from '@fwlm/observability';

// store-detail 側の責務である（この語に当たって緑になってはならない）
export function run(): void {
  writeStructuredLog('info', 'demo.started');
}
EOF
fx_run check-log-field-binding
expect_red '項目名「detail」が現れません'
t_end

# ---------------------------------------------------------------------------
# 宣言の矛盾と空振り防止

t_begin 'check-log-field-binding: 名前が無い層に出典を宣言すると赤'
fx_guard check-log-field-binding
lfb_fixture
# 日次バッチ層の名前が「該当なし」なのに go/ の出典を持つ、という矛盾した宣言。
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 相関識別子 | `correlationId` | 該当なし | 新規 | `ts/packages/observability/src/fields.ts` ／ `go/internal/demo/log.go` | 矛盾した宣言 |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `demo.started` | demo | 既存 | `ts/apps/demo/src/log.ts` | |
EOF
fx_write ts/packages/observability/src/fields.ts <<'EOF'
export interface LogFields {
  readonly correlationId?: string;
}
EOF
fx_run check-log-field-binding
expect_red '名前が無いのに出典がある'
t_end

t_begin 'check-log-field-binding: 型定義が無ければ赤（空振り防止）'
fx_guard check-log-field-binding
lfb_fixture
rm -f "${FX}/ts/packages/observability/src/fields.ts"
fx_run check-log-field-binding
expect_red '逆方向の照合ができません'
t_end

t_begin 'check-log-field-binding: 表のヘッダが変われば 0 件で緑を返さない（空振り防止）'
fx_guard check-log-field-binding
# ヘッダに列を足すと表の抽出が全件落ちる。取りこぼしを緑と報告してはならない。
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 | 追加列 |
|---|---|---|---|---|---|---|
| 相関識別子 | `correlationId` | 該当なし | 新規 | `ts/packages/observability/src/fields.ts` | | |
EOF
fx_write ts/packages/observability/src/fields.ts <<'EOF'
export interface LogFields {
  readonly correlationId?: string;
}
EOF
fx_run check-log-field-binding
expect_red '1 件も検証できませんでした'
t_end

# ---------------------------------------------------------------------------
# 独立検証（2026-09-09）の指摘: 実装が正典に無い事象名を出しても捕まらなかった。
# 正典が「名前の唯一の基準」であるという主張が、前方に対して成立していなかった。

t_begin 'check-log-field-binding: 正典に無い事象名を実装が出すと赤'
fx_guard check-log-field-binding
lfb_fixture
fx_write ts/apps/demo/src/log.ts <<'EOF'
import { writeStructuredLog } from '@fwlm/observability';

export const STORE_KEY = 'storeId';

export function run(): void {
  writeStructuredLog('info', 'demo.started', { storeId: 'store-1' });
  writeStructuredLog('warn', 'demo.unregistered', { storeId: 'store-1' });
}
EOF
fx_run check-log-field-binding
expect_red '正典に登録されていません'
t_end

t_begin 'check-log-field-binding: 注入 logger 経由の未登録事象も逆方向で赤'
fx_guard check-log-field-binding
lfb_fixture
# 直呼びの既知事象を残して旧ガードの「抽出 0 件」防止を通し、注入 logger の未登録事象だけを追加する。
fx_write ts/apps/demo/src/log.ts <<'EOF'
import { writeStructuredLog } from '@fwlm/observability';

export function run(deps: { logger: { warn(event: string): void } }): void {
  writeStructuredLog('info', 'demo.started', { storeId: 'store-1' });
  deps.logger.warn('demo.unregistered');
}
EOF
fx_run check-log-field-binding
expect_red '正典に登録されていません'
t_end

t_begin 'check-log-field-binding: 空白入りの未登録 event 値も逆方向で赤'
fx_guard check-log-field-binding
lfb_fixture
# event 値が識別子形式でなくても、抽出後に捨てず正典との不一致として検出する。
fx_write ts/apps/demo/src/log.ts <<'EOF'
import { writeStructuredLog } from '@fwlm/observability';

export function run(deps: { logger: { warn(event: string): void } }): void {
  writeStructuredLog('info', 'demo.started', { storeId: 'store-1' });
  deps.logger.warn('demo unregistered');
}
EOF
fx_run check-log-field-binding
expect_red '事象名「demo unregistered」を出しますが、正典に登録されていません'
t_end

t_begin 'check-log-field-binding: 正典の出典ファイルが走査対象外なら赤'
fx_guard check-log-field-binding
lfb_fixture
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 店舗の識別子 | `storeId` | `store_id` | 既存 | `ts/packages/observability/src/fields.ts` ／ `go/internal/demo/log.go` | 変更禁止 |
| 相関識別子 | `correlationId` | 該当なし | 新規 | `ts/packages/observability/src/fields.ts` | 出力時は別名へ写す |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `demo.started` | demo | 既存 | `ts/apps/demo/test/log.ts` | |
EOF
fx_write ts/apps/demo/test/log.ts <<'EOF'
writeStructuredLog('info', 'demo.started', { storeId: 'store-1' });
EOF
fx_run check-log-field-binding
expect_red '逆方向の事象走査対象に含まれていません'
t_end

t_begin 'check-log-field-binding: 実装の事象名を 1 件も拾えなければ赤（空振り防止）'
fx_guard check-log-field-binding
lfb_fixture
# 共有経路の呼び出しが無い＝抽出の前提が崩れている。取りこぼしを緑と報告してはならない。
fx_write ts/apps/demo/src/log.ts <<'EOF'
export const STORE_KEY = 'storeId';
export const EVENT = 'demo.started';
EOF
fx_run check-log-field-binding
expect_red '実装から事象名を 1 件も抽出できませんでした'
t_end

# ---------------------------------------------------------------------------
# Issue #250: 逆方向の抽出が `writeStructuredLog(` / `correlationLog(` の 2 形しか見ておらず、
# 面ごとの logger（`deps.logger.warn('<事象名>', …)`）と Sink を受けた局所呼び出し
# （`log('warn', '<事象名>', …)`）で出す事象名が、正典に無くても緑だった。

t_begin 'check-log-field-binding: logger.<level> で出す未登録の事象名を赤にする'
fx_guard check-log-field-binding
lfb_fixture
fx_write ts/apps/demo/src/logger.ts <<'EOF'
export function onFailure(deps: { logger: { warn: (e: string, f?: object) => void } }): void {
  deps.logger.warn('demo.logger_unregistered', { errorKind: 'Error' });
}
EOF
fx_run check-log-field-binding
expect_red '事象名「demo.logger_unregistered」を出しますが、正典に登録されていません'
t_end

t_begin 'check-log-field-binding: Sink の局所呼び出しで出す未登録の事象名を赤にする'
fx_guard check-log-field-binding
lfb_fixture
fx_write ts/apps/demo/src/sink-local.ts <<'EOF'
import type { Sink } from '@fwlm/observability';

export function onFailure(log: Sink): void {
  log('error', 'demo.sink_unregistered', { storeId: 'store-1' });
}
EOF
fx_run check-log-field-binding
expect_red '事象名「demo.sink_unregistered」を出しますが、正典に登録されていません'
t_end

t_begin 'check-log-field-binding: logger.<level> の登録済みの事象名は数えて緑'
fx_guard check-log-field-binding
lfb_fixture
fx_write docs/observability/log-field-canon.md <<'EOF'
# 記録の正典（テスト用）

## 1. 項目名

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 店舗の識別子 | `storeId` | `store_id` | 既存 | `ts/packages/observability/src/fields.ts` ／ `go/internal/demo/log.go` | 変更禁止 |
| 相関識別子 | `correlationId` | 該当なし | 新規 | `ts/packages/observability/src/fields.ts` | 出力時は別名へ写す |

## 2. 事象名

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `demo.started` | demo | 既存 | `ts/apps/demo/src/log.ts` | |
| `demo.logger_started` | demo | 既存 | `ts/apps/demo/src/logger.ts` | |
EOF
fx_write ts/apps/demo/src/logger.ts <<'EOF'
export function onStart(deps: { logger: { info: (e: string) => void } }): void {
  deps.logger.info('demo.logger_started');
}
EOF
fx_run check-log-field-binding
expect_green
expect_output_matches '実装の事象名 2 件'
t_end

t_begin 'check-log-field-binding: 省略可能な呼び出し（log?.( / logger?.warn()で出す未登録の事象名も赤にする'
fx_guard check-log-field-binding
lfb_fixture
fx_write ts/apps/demo/src/optional.ts <<'EOF'
import type { Sink } from '@fwlm/observability';

export function onFailure(log: Sink | undefined, logger?: { warn: (e: string) => void }): void {
  log?.('warn', 'demo.optional_sink_unregistered');
  logger?.warn('demo.optional_logger_unregistered');
}
EOF
fx_run check-log-field-binding
expect_red '事象名「demo.optional_sink_unregistered」を出しますが'
expect_red '事象名「demo.optional_logger_unregistered」を出しますが'
t_end

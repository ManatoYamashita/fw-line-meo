# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-log-sink-usage.sh の自己テスト（Issue #228 タスク 2.3）。
#
# 対象は走査のみで実行環境に依存しないため、skip 条件を持たない。
#
# **除外が効いていることの検証を含める。** 運用者が手で叩く補助スクリプトの人間向け出力を
# 対象へ含めると、移送を全部終えても消えない赤が残り、実装者が本ガード自身の規則に反する
# 除外を発明する羽目になる。

# 共有経路だけが書き出す、整った状態。
lsu_fixture() {
  fx_write ts/packages/observability/src/sink.ts <<'EOF'
export const writeStructuredLog = (level: 'info' | 'warn' | 'error', line: string): void => {
  console[level](line);
};
EOF
  fx_write ts/packages/observability/src/fields.ts <<'EOF'
export interface LogFields {
  readonly storeId?: string;
}
EOF
  fx_write ts/apps/demo/src/index.ts <<'EOF'
import { writeStructuredLog } from '@fwlm/observability';

export function run(): void {
  writeStructuredLog('info', 'demo.started');
}
EOF
}

t_begin 'check-log-sink-usage: 共有経路だけが書き出していれば緑'
fx_guard check-log-sink-usage
lsu_fixture
fx_run check-log-sink-usage
expect_green
t_end

t_begin 'check-log-sink-usage: 実行時ソースの直接の書き出しを検出する'
fx_guard check-log-sink-usage
lsu_fixture
fx_write ts/apps/demo/src/index.ts <<'EOF'
export function run(): void {
  console.error('直接の書き出し');
}
EOF
fx_run check-log-sink-usage
expect_red '共有経路を経由せず'
t_end

t_begin 'check-log-sink-usage: ブラケット記法の書き出しも検出する'
fx_guard check-log-sink-usage
lsu_fixture
# ドット記法だけを見ると、この形も、共有経路の sink 自身も検出できない。
fx_write ts/apps/demo/src/index.ts <<'EOF'
export function run(level: 'info' | 'error'): void {
  console[level]('ブラケット記法での書き出し');
}
EOF
fx_run check-log-sink-usage
expect_red '共有経路を経由せず'
t_end

t_begin 'check-log-sink-usage: 標準出力への直接の書き込みも検出する'
fx_guard check-log-sink-usage
lsu_fixture
fx_write ts/apps/demo/src/index.ts <<'EOF'
export function run(): void {
  process.stdout.write('直接の書き込み\n');
}
EOF
fx_run check-log-sink-usage
expect_red '共有経路を経由せず'
t_end

t_begin 'check-log-sink-usage: app 配下も走査する'
fx_guard check-log-sink-usage
lsu_fixture
# 店舗詳細面の記録は app/ 配下にある。src/ だけに絞ると移送前でも赤くならない。
fx_write ts/apps/demo/app/api/detail/route.ts <<'EOF'
export function GET(): void {
  console.error('app 配下の書き出し');
}
EOF
fx_run check-log-sink-usage
expect_red 'app/api/detail/route.ts'
t_end

# ---------------------------------------------------------------------------
# 除外が効いていることの検証（ここを誤ると、消えない赤が残る）

t_begin 'check-log-sink-usage: 運用者向け補助スクリプトの出力では赤にしない'
fx_guard check-log-sink-usage
lsu_fixture
# 運用者が手で叩いて結果を読むための出力であり、記録ではない。
fx_write ts/apps/line-webhook/scripts/setup-rich-menus.ts <<'EOF'
export function main(): void {
  console.log('richMenuId を控えてください');
}
EOF
fx_run check-log-sink-usage
expect_green
expect_absent 'setup-rich-menus'
t_end

t_begin 'check-log-sink-usage: テストの出力では赤にしない'
fx_guard check-log-sink-usage
lsu_fixture
fx_write ts/apps/demo/test/demo.test.ts <<'EOF'
it('logs', () => {
  console.log('テストの出力');
});
EOF
fx_run check-log-sink-usage
expect_green
t_end

t_begin 'check-log-sink-usage: src 配下でもテストファイルは対象外にする'
fx_guard check-log-sink-usage
lsu_fixture
fx_write ts/apps/demo/src/demo.test.ts <<'EOF'
it('logs', () => {
  console.log('src 配下のテスト');
});
EOF
fx_run check-log-sink-usage
expect_green
t_end

# ---------------------------------------------------------------------------
# 記録してはならない値と空振り防止

t_begin 'check-log-sink-usage: 型に利用者の識別子があると赤'
fx_guard check-log-sink-usage
lsu_fixture
fx_write ts/packages/observability/src/fields.ts <<'EOF'
export interface LogFields {
  readonly storeId?: string;
  readonly lineUserId?: string;
}
EOF
fx_run check-log-sink-usage
expect_red '記録に載せません'
t_end

t_begin 'check-log-sink-usage: 書き出しを 1 件も拾えなければ赤（空振り防止）'
fx_guard check-log-sink-usage
# 共有経路の sink 自身すら検出できない状態は、記法の前提が崩れた証拠である。
fx_write ts/packages/observability/src/sink.ts <<'EOF'
export const writeStructuredLog = (line: string): void => {
  void line;
};
EOF
fx_write ts/packages/observability/src/fields.ts <<'EOF'
export interface LogFields {
  readonly storeId?: string;
}
EOF
# 走査対象そのものは在る状態にする（apps が無いと別の理由で赤になり、
# 「抽出 0 件」の軸を検証したことにならない）。
fx_write ts/apps/demo/src/index.ts <<'EOF'
export function run(): void {
  void 0;
}
EOF
fx_run check-log-sink-usage
expect_red '1 件も抽出できませんでした'
t_end

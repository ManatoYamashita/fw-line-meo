# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-swallowed-exceptions.sh の自己テスト（Issue #233）。

se_fixture() {
  fx_guard check-swallowed-exceptions
  fx_write ts/apps/example/src/handled.ts <<'EOF'
export function handled(): void {
  try {
    throw new Error('expected');
  } catch {
    return;
  }
}
EOF
  fx_write ts/apps/example/src/intentional.ts <<'EOF'
export function intentional(): void {
  try {
    throw new Error('secondary');
  } catch {
    // swallowed-exception: intentional — 補助処理の失敗を本処理へ伝播させない。
  }
}
EOF
}

t_begin 'check-swallowed-exceptions: 処理済みと理由付き吸収は緑'
se_fixture
fx_run check-swallowed-exceptions
expect_green
expect_output_matches '実行時コード 2 ファイルの空 catch を検査しました'
t_end

t_begin 'check-swallowed-exceptions: 理由のない空 catch は赤'
se_fixture
fx_write ts/apps/example/src/swallowed.ts <<'EOF'
export function swallowed(): void {
  try {
    throw new Error('lost');
  } catch (error) {
    // 何もしない。
  }
}
EOF
fx_run check-swallowed-exceptions
expect_red 'src/swallowed.ts:4: 空の catch が例外を握り潰しています'
t_end

t_begin 'check-swallowed-exceptions: 理由のない意図的注釈も赤'
se_fixture
fx_write ts/apps/example/src/unexplained.ts <<'EOF'
export function unexplained(): void {
  try {
    throw new Error('lost');
  } catch {
    // swallowed-exception: intentional
  }
}
EOF
fx_run check-swallowed-exceptions
expect_red '例外吸収の注釈に理由がありません'
t_end

t_begin 'check-swallowed-exceptions: 文字列とコメント中の catch は誤検出しない'
se_fixture
fx_write ts/apps/example/src/text.ts <<'EOF'
export const text = 'catch { this is not code }';
// catch { this is also not code }
EOF
fx_run check-swallowed-exceptions
expect_green
t_end

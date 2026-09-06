# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-button-variants-cn.sh の自己テスト（Issue #208）。
#
# 本ガードが守るのは「面が部品の見た目を借りて描画するときは cn() を通す」である。
# 破れたときの症状は赤ではなく **透明な枠** で、寸法も角丸も文字色も一致するため
# class 比較でも jsdom でも落ちない。PR #200 / #211 で 3 回踏んだ。
#
# **射程の狭さそのものを固定する。** `buttonVariants(` を呼ぶこと自体は禁じない。テストは
# 「部品が自分で作るぶん」を差し引く基準として生の cva を呼んでおり、そこへ cn() を通すと
# 差し引きの基準が変わって検査のほうが壊れる。射程を広げる改変が入ったとき、
# 「解析用途は素通しする」ケースが赤くなって気づけるようにしてある。

bvc_tree() {
  fx_guard check-button-variants-cn

  # 規律を満たす面（cn() を通して借りている）。
  fx_write ts/apps/good-face/src/app/page.tsx <<'EOF'
import { buttonVariants } from '@fwlm/ui/components/button';
import { cn } from '@fwlm/ui/lib/utils';

export default function Page() {
  return (
    <a href="/x" className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}>
      借りる
    </a>
  );
}
EOF

  # 解析用途（描画へ渡していない）。**素通しされなければならない。**
  fx_write ts/apps/good-face/test/page.test.tsx <<'EOF'
import { buttonVariants } from '@fwlm/ui/components/button';

it('面が足したぶんだけを見る', () => {
  const own = new Set(buttonVariants({ size: 'lg' }).split(/\s+/));
  expect(own.size).toBeGreaterThan(0);
});
EOF
}

t_begin 'check-button-variants-cn: cn() を通していれば緑（件数まで照合）'
bvc_tree
fx_run check-button-variants-cn
expect_green
# 件数を照合する。走査が空振りしたまま緑になる経路と区別するため。
expect_output_matches '1 件検証'
t_end

t_begin 'check-button-variants-cn: 裸で className へ渡すと赤'
bvc_tree
fx_write ts/apps/good-face/src/app/page.tsx <<'EOF'
import { buttonVariants } from '@fwlm/ui/components/button';

export default function Page() {
  return (
    <a href="/x" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
      借りる
    </a>
  );
}
EOF
fx_run check-button-variants-cn
expect_red 'cn() を通さずに buttonVariants を className へ渡している箇所があります'
t_end

# 射程の下限。**解析用途を巻き込むと、正しい検査のほうが書けなくなる。**
# ここが赤くなったら、それは射程を広げすぎた合図である。
t_begin 'check-button-variants-cn: className へ渡さない呼び出しは赤にしない'
bvc_tree
fx_write ts/apps/good-face/test/page.test.tsx <<'EOF'
import { buttonVariants } from '@fwlm/ui/components/button';

it('部品が作るぶんを差し引く', () => {
  const own = new Set(
    buttonVariants({ variant: 'outline', size: 'lg' })
      .split(/\s+/)
      .filter((value) => value.length > 0),
  );
  expect(own.size).toBeGreaterThan(0);
});
EOF
fx_run check-button-variants-cn
expect_green
t_end

# 空振り防止。対象 0 件は「守っている」ではなく「何も見ていない」。
t_begin 'check-button-variants-cn: 受け渡しが 0 件なら赤（空振り防止）'
fx_guard check-button-variants-cn
fx_write ts/apps/plain-face/src/app/page.tsx <<'EOF'
export default function Page() {
  return <p>借りない面</p>;
}
EOF
fx_run check-button-variants-cn
expect_red 'className へ buttonVariants を渡している箇所が 1 件もありません'
t_end

# grep が評価不能（exit 2）のとき、無一致（exit 1）と同一視して緑を返してはならない。
# **落とす grep を引数で指定する。** 一律に落とすと最初の走査で必ず赤くなり、
# 2 本目の走査の分岐を一度も検査しないまま「覆った」と誤認する。
t_begin 'check-button-variants-cn: grep が評価不能なら赤（無一致と混同しない）'
bvc_tree
# **判別に `[[:space:]]` を使わない。** case のグロブはこれを文字クラスとして解釈するため、
# ERE を literal として照合できない（実際に空振りした）。2 本の走査は「包んでいる側の
# パターンだけが `cn\(` を含む」ことで見分ける。
bvc_real_grep="$(PATH="$FX_BASE_PATH" command -v grep)"
cat > "${STUB_DIR}/grep" <<STUB
#!/usr/bin/env bash
case "\$*" in
  *'cn\('*) ;;
  *buttonVariants*) echo "grep-stub: simulated read error" >&2; exit 2 ;;
esac
exec "${bvc_real_grep}" "\$@"
STUB
chmod +x "${STUB_DIR}/grep"
fx_run check-button-variants-cn
expect_red '走査を評価できません'
t_end

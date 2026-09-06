# scripts/check-compliance-wording.sh の自己テスト（Issue #179）。
#
# 本ガードは「検知を回避することを目的として述べた記述」が正典から消えたまま戻らないことと、
# 文面介入の禁止が明文で在り続けることを機械強制する。2026-09-06 の是正前は 4 箇所が
# 「検知されないように語彙を変える」という順序で書かれており、**既存のどの検査も緑だった**。
#
# 誤検出しないことの担保が要る観点が 3 つある。いずれも実在の記述に存在する形である。
#   1. 回避の語だけの行（「循環回避」「衝突回避」「SIGPIPE 偽陽性の回避」）は違反ではない。
#      このリポジトリには 50 件超あり、ここを落とすと生まれた瞬間に赤いガードになる
#   2. 正典の外で検知器の名前だけを使う行（「通知の◯◯防止」）は違反ではない
#   3. 未追跡ファイルは走査されない。これは欠陥ではなく **意図した射程**である（Issue #214）
#
# 逆に、規則1 と規則2 は**別々の形を捕らえる**。requirements.md §9 のリスク表の行には回避語が
# 無いため共起では当たらず、規則1（正典での語の禁止）だけが捕らえる。両方を持つ理由がこれで、
# 片方だけにするとどちらかの実在した違反が素通りする。
#
# fixture は正典 4 文書とアンカー 2 件、自己言及の除外が指す実体を必ず備える。欠けると本ガードは
# 別の理由で赤くなり、**どのケースも意図した経路を検査できない**。

CW_MARKER='下書き文面への介入禁止'

cw_fixture() {
  fx_guard check-compliance-wording

  # --- grep スタブ -------------------------------------------------------
  # 既定は実物へ委譲し、CW_GREP_FAIL の子プロセスでだけ exit 2 を返す。**どの grep を落とすかを
  # 引数で指定する。** 一律に落とすと最初の grep で必ず赤くなり、後続の経路の exit 2 分岐を
  # 1 件も検査しないまま「覆った」と誤認する（61 番ケースと同じ理由）。
  cw_real_grep="$(PATH="$FX_BASE_PATH" command -v grep)"
  cat > "${STUB_DIR}/grep" <<STUB
#!/usr/bin/env bash
if [ -n "\${CW_GREP_FAIL:-}" ]; then
  case "\$*" in
    *"\${CW_GREP_FAIL}"*) echo "grep-stub: simulated read error" >&2; exit 2 ;;
  esac
fi
exec "${cw_real_grep}" "\$@"
STUB
  chmod +x "${STUB_DIR}/grep"

  # --- 自己言及の除外が指す実体 ------------------------------------------
  # ガードは SELF_EXEMPT の実在を要求する。除外だけが残ると規則2 の射程が静かに広がるため。
  fx_write scripts/test/cases/62-check-compliance-wording.sh <<'EOF'
# 合成ツリー側の置き石。実体があることだけが要求される。
EOF

  # --- 正典 4 文書（うち 2 件がアンカー） --------------------------------
  fx_write CLAUDE.md <<'EOF'
# CLAUDE.md

## 侵してはならない制約

- **レビューゲーティング禁止**: 低評価客も同一導線で誘導する。
- **AI ガードレール**: 嘘・誇張・誹謗中傷を生成しない。客本人が選んだ事実のみ反映。素材が客ごとに異なる以上、語彙も客ごとに異なる。
- **下書き文面への介入禁止**: オーナー・代理店が下書きの文面へ介入する経路を実装してはならない。
EOF

  fx_write requirements.md <<'EOF'
# 要件定義書

## 9. リスク

| リスク | 内容 | 対応方針 |
|---|---|---|
| 類似下書きの量産 | 同じ文面が並ぶと実体験の記録として読まれない | 素材が客ごとに異なるため文面も異なる |
EOF

  fx_write .kiro/steering/product.md <<'EOF'
# Product

## 侵してはならない制約（プロダクト境界）

- **代理投稿禁止**: 客本人が投稿する。
- **下書き文面への介入禁止**: 下書きの文面・プロンプトへ介入する経路を実装してはならない。
EOF

  fx_write .kiro/specs/review-acquisition/requirements.md <<'EOF'
# Requirements Document

3. 客ごとに語彙・構成・切り口を変えて下書きを生成し、同一店舗で定型文の繰り返しにならないようにする
EOF

  # --- 正典の外（コード） -------------------------------------------------
  # 回避の語だけを持つ行を混ぜる。**ここが誤爆すると生まれた瞬間に赤いガードになる。**
  fx_write ts/apps/line-webhook/test/line/messages.test.ts <<'EOF'
// UUID の衝突回避のため prefix を分ける。
// SIGPIPE 偽陽性の回避のため grep -c で件数を数える。
const OBVIOUS_ENGLISH_PLACEHOLDERS = ['TODO', 'FIXME'];
EOF

  fx_write scripts/some-other-guard.sh <<'EOF'
# 循環回避のため、SA を作る側が同一モジュール内で DB ユーザーを作る。
EOF
}

# grep が exit 2 を返す状況で走らせる専用の runner（$1 = 落とす対象の引数の部分文字列）。
# t_begin がプロセスの PATH をスタブへ差し替えているが、環境変数の注入はここでしか行えない。
cw_run_grep_fail() {
  # fx_run と同じく、まだ git 化されていなければここで追跡させる（Issue #82）。
  # 独自 runner がこれを忘れると `fatal: not a git repository` で別原因の赤になり、
  # 期待した経路を 1 行も通らないまま「赤くなった」と読める。
  [ -d "${FX}/.git" ] || fx_track_now
  OUT=''
  RC=0
  OUT="$(cd "$FX" && PATH="${STUB_DIR}:${FX_BASE_PATH}" CW_GREP_FAIL="$1" bash scripts/check-compliance-wording.sh 2>&1)" || RC=$?
}

# ---------------------------------------------------------------------------

t_begin 'check-compliance-wording: 正典が清潔で明文が在れば緑（件数とアンカー数まで照合）'
cw_fixture
fx_run check-compliance-wording
expect_green
# **件数まで固定する。** シェル先食いの是正前は「走査 5 ファイル」だった（`.kiro/` 配下の
# 2 件が射程から落ちていた）。射程が痩せたときに差分へ出る唯一の痕跡がこの数である。
expect_output_matches '正典 4 ファイル / 走査 7 ファイル / アンカー 2 件・WHITELIST 0 件'
t_end

t_begin 'check-compliance-wording: 正典に検知器の名前があると赤（規則1）'
cw_fixture
# 回避の語を持たない行にする。**規則2 では当たらない形**であることが要点で、
# これが requirements.md §9 のリスク表で実際に起きていた形である。
printf '%s\n' "| クチコミのスパム検知 | 類似下書きの量産は停止を招く | 語彙を変えて生成 |" >> "${FX}/requirements.md"
fx_run check-compliance-wording
expect_red 'requirements.md は外部審査で読まれる正典ですが、検知器の名前が書かれています'
# **規則2 は当たらない。** 共起の正規表現だけを持っていたら、この行は素通りしていた。
expect_absent 'requirements.md に検知の回避を目的として述べる語形があります'
t_end

t_begin 'check-compliance-wording: 対照 — その 1 行を戻せば緑（赤の原因が検知器の名前であることの担保）'
cw_fixture
fx_run check-compliance-wording
expect_green
t_end

t_begin 'check-compliance-wording: 直下ではない .md も規則2 の射程に入る（シェル先食いの回帰）'
cw_fixture
# **是正前の本ガードはここで緑を返していた。** `git ls-files -- ${SCAN_PATHSPECS}` の引用符なし
# 展開により `*.md` がリポジトリ直下だけへ先に展開され、git は glob ではなく直下の実ファイル名
# だけを受け取っていた（実測: 3 件 対 116 件・うち 87 件が .kiro/ 配下）。直下に該当が無い
# `*.ts` は glob のまま渡るため、**拡張子ごとに射程が食い違う**という最悪の形だった。
fx_write docs/design/nested-note.md <<'EOF'
- 客ごとに語彙を変えスパム判定を回避する。
EOF
fx_run check-compliance-wording
expect_red 'docs/design/nested-note.md に検知の回避を目的として述べる語形があります'
t_end

t_begin 'check-compliance-wording: 正典の外でも回避を目的として述べる語形は赤（規則2）'
cw_fixture
# 是正前の ts/apps/line-webhook/test/line/messages.test.ts:43 と同じ形。
printf '%s\n' "// スパム判定回避用の英語プレースホルダ混入がないことのスポットチェック。" \
  >> "${FX}/ts/apps/line-webhook/test/line/messages.test.ts"
fx_run check-compliance-wording
expect_red 'ts/apps/line-webhook/test/line/messages.test.ts に検知の回避を目的として述べる語形があります'
# 正典ではないので規則1 は発火しない（射程の分界が保たれていること）。
expect_absent 'は外部審査で読まれる正典ですが'
t_end

t_begin 'check-compliance-wording: 回避の語だけの行は誤爆させない（循環回避・衝突回避）'
cw_fixture
# fixture は既に 3 件の「回避」を持つ。さらに足しても緑であることを固定する。
printf '%s\n' "# 一斉リクエストの回避のため起動ジッターを入れる。" >> "${FX}/scripts/some-other-guard.sh"
fx_run check-compliance-wording
expect_green
t_end

t_begin 'check-compliance-wording: 正典の外で検知器の名前だけを使う行は誤爆させない（通知の防止）'
cw_fixture
# scripts/test/cases/60-check-prod-image-drift.sh に実在する形（別概念）。
printf '%s\n' "# 通知のスパム防止は早期異常の経路でこそ効く。" >> "${FX}/scripts/some-other-guard.sh"
fx_run check-compliance-wording
expect_green
t_end

t_begin 'check-compliance-wording: CLAUDE.md から文面介入の禁止が消えると赤（規則3・肯定側）'
cw_fixture
sed -i.bak "/${CW_MARKER}/d" "${FX}/CLAUDE.md"
rm -f "${FX}/CLAUDE.md.bak"
fx_run check-compliance-wording
expect_red 'CLAUDE.md に「下書き文面への介入禁止」の明文がありません'
# product.md 側は残っているので、片方だけが落ちることを確かめる（両方を一括で見ていない）。
expect_absent '.kiro/steering/product.md に「下書き文面への介入禁止」の明文がありません'
t_end

t_begin 'check-compliance-wording: steering から文面介入の禁止が消えても赤（アンカー 2 件が独立）'
cw_fixture
sed -i.bak "/${CW_MARKER}/d" "${FX}/.kiro/steering/product.md"
rm -f "${FX}/.kiro/steering/product.md.bak"
fx_run check-compliance-wording
expect_red '.kiro/steering/product.md に「下書き文面への介入禁止」の明文がありません'
expect_absent 'CLAUDE.md に「下書き文面への介入禁止」の明文がありません'
t_end

t_begin 'check-compliance-wording: アンカーが正典の走査対象から外れると赤（改名・移動の検出）'
cw_fixture
rm -f "${FX}/CLAUDE.md"
fx_run check-compliance-wording
expect_red 'アンカー CLAUDE.md が正典の走査対象に含まれていません'
t_end

t_begin 'check-compliance-wording: 未追跡ファイルは走査しない（射程の明示・Issue #214）'
cw_fixture
fx_track_now
# 追跡させたあとに違反ファイルを書く。**緑であることが正しい。** AGENTS.md がこの状態にある。
fx_write docs/untracked-note.md <<'EOF'
- 客ごとに語彙を変えスパム判定を回避する。
EOF
fx_run check-compliance-wording
expect_green
expect_absent 'docs/untracked-note.md'
t_end

t_begin 'check-compliance-wording: 自己言及の除外が実在しないと赤（除外だけが残る状態）'
cw_fixture
rm -f "${FX}/scripts/test/cases/62-check-compliance-wording.sh"
fx_run check-compliance-wording
expect_red '自己言及の除外 scripts/test/cases/62-check-compliance-wording.sh が実在しません'
t_end

t_begin 'check-compliance-wording: 自己言及の除外は空振りしていない（外すと自己テストで赤くなる）'
cw_fixture
# 自己テストの実体に違反の形を書く（実物の 62 番ケースが fixture として持っている状態を模す）。
printf '%s\n' "printf '%s' \"客ごとに語彙を変えスパム判定を回避\"" \
  >> "${FX}/scripts/test/cases/62-check-compliance-wording.sh"
fx_run check-compliance-wording
expect_green
# 除外を外すと同じツリーが赤くなる。**除外が効いていることの対照**であり、
# これが無いと「たまたま違反が無いから緑」と区別が付かない。
fx_guard_mutate check-compliance-wording -e "s|^SELF_EXEMPT='scripts/test/cases/62-check-compliance-wording.sh'|SELF_EXEMPT=''|"
fx_run check-compliance-wording
expect_red 'scripts/test/cases/62-check-compliance-wording.sh に検知の回避を目的として述べる語形があります'
t_end

t_begin 'check-compliance-wording: 走査対象が 1 件も無いとき緑を返さない'
cw_fixture
fx_guard_mutate check-compliance-wording -e "s|^SCAN_PATHSPECS=.*|SCAN_PATHSPECS='*.nonexistent-extension'|"
fx_run check-compliance-wording
expect_red '走査対象が 1 件もありません'
t_end

t_begin 'check-compliance-wording: 正典が 1 件も無いとき緑を返さない'
cw_fixture
fx_guard_mutate check-compliance-wording -e "s|^CANON_PATHSPECS=.*|CANON_PATHSPECS='*.nonexistent-canon'|"
fx_run check-compliance-wording
expect_red '正典文書が 1 件もありません'
t_end

t_begin 'check-compliance-wording: 正典の走査が評価不能なら違反 0 件と読まない（grep exit 2）'
cw_fixture
cw_run_grep_fail 'requirements.md'
expect_red 'の走査が評価不能でした'
t_end

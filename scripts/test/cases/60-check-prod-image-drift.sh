# scripts/check-prod-image-drift.sh の自己テスト（Issue #91）。
#
# 本ガードは「main は正しいのに本番へ届いていない」を、マージ契機ではなく時間で検出する。
# 判定は git の履歴と時刻に依存するため、**使い捨ての git リポジトリと現在時刻を注入**して
# 決定論的に再現する（DRIFT_REPO_DIR / DRIFT_NOW_EPOCH / PROD_IMAGE_SNAPSHOT / DRIFT_TARGETS_FILE）。
# 本番の gcloud には一切問い合わせない。
#
# 猶予の判定には**二重の落とし穴**があり、どちらも「赤にならない／不必要に赤くなる」という形で
# 症状が出ないため、対照つきのケースで両方を固定する:
#   - main HEAD の経過時間で測ると、7 日停止している最中に新規マージが入った瞬間に緑へ戻る
#   - 素の rev-list で最古を測ると、feature ブランチの古い committer date で誤報する
#     （3 時間前に書いたコミットを 4 分前にマージしただけで猶予超過になる。PR #92 で実測）

PID_NOW=1770000000
PID_BASE=reg.example/proj/fwlm

pid_commit() {
  # $1 = committer date（epoch）, $2 = メッセージ。標準出力に commit SHA を返す。
  echo "$2" > "${FX}/repo/f.txt"
  git -C "${FX}/repo" add f.txt
  GIT_AUTHOR_DATE="@$1 +0000" GIT_COMMITTER_DATE="@$1 +0000" \
    git -C "${FX}/repo" commit -q -m "$2"
  git -C "${FX}/repo" rev-parse HEAD
}

pid_fixture() {
  # 直線的な履歴を持つリポジトリ: c1(30日前) → c2(7日前) → c3(6日前) → c4(5分前) = origin/main
  fx_guard check-prod-image-drift
  git init -q "${FX}/repo"
  git -C "${FX}/repo" symbolic-ref HEAD refs/heads/main
  git -C "${FX}/repo" config user.email guard@example.com
  git -C "${FX}/repo" config user.name guard
  git -C "${FX}/repo" config commit.gpgsign false
  PID_C1="$(pid_commit $((PID_NOW - 30 * 86400)) c1)"
  pid_commit $((PID_NOW - 7 * 86400)) c2 >/dev/null
  pid_commit $((PID_NOW - 6 * 86400)) c3 >/dev/null
  PID_C4="$(pid_commit $((PID_NOW - 300)) c4)"
  git -C "${FX}/repo" update-ref refs/remotes/origin/main "$PID_C4"
  printf 'service\tweb\njob\tbatch\n' | fx_write targets.tsv
}

pid_snapshot() {
  # $1 = 全コンポーネントに与えるタグ。収束済みの正常な状態を作る。
  {
    printf 'service\tweb\t%s/web:%s\t7\t7\tweb-00007-aaa\tweb-00007-aaa\tweb-00007-aaa\n' "$PID_BASE" "$1"
    printf 'job\tbatch\t%s/batch:%s\t-\t-\t-\t-\t-\n' "$PID_BASE" "$1"
  } | fx_write snapshot.tsv
}

pid_short() {
  # $1 = commit, $2 = 桁数
  git -C "${FX}/repo" rev-parse --short="$2" "$1"
}

pid_run() {
  # 注入用の環境変数はこの関数の中で閉じる（ケース間に漏らさない）。
  # $1 が与えられていれば DRIFT_NOW_EPOCH をそれで上書きする。
  # fx_run 相当だが、このガードだけは環境変数で状態を注入するため専用の runner を持つ。
  OUT=''
  RC=0
  # shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
  OUT="$(cd "$FX" && \
    PROJECT_ID=proj \
    IMAGE_BASE="$PID_BASE" \
    DRIFT_REPO_DIR="${FX}/repo" \
    DRIFT_TARGETS_FILE="${FX}/targets.tsv" \
    PROD_IMAGE_SNAPSHOT="${FX}/snapshot.tsv" \
    DRIFT_NOW_EPOCH="${1:-$PID_NOW}" \
    DRIFT_GRACE_MINUTES="${PID_GRACE:-90}" \
    DRIFT_MAIN_REF="${PID_MAIN_REF:-origin/main}" \
    bash scripts/check-prod-image-drift.sh 2>&1)" || RC=$?
}

t_begin 'check-prod-image-drift: 全コンポーネントが main と一致していれば緑'
pid_fixture
pid_snapshot "$(pid_short "$PID_C4" 7)"
pid_run
expect_green
expect_output_matches '2 件検証'
t_end

# 対照: 同じ「1 コミット遅れ」でも、猶予の内か外かだけで結論が変わることを示す。
t_begin 'check-prod-image-drift: 直近マージ待ちは猶予内なら緑（in-flight）'
pid_fixture
pid_snapshot "$(pid_short "${PID_C4}~1" 7)"
pid_run
expect_green
expect_output_matches 'in-flight'
t_end

t_begin 'check-prod-image-drift: 同じ状態でも猶予を超えたら赤（behind）'
pid_fixture
pid_snapshot "$(pid_short "${PID_C4}~1" 7)"
pid_run $((PID_NOW + 7200))
expect_red 'behind'
# 経過の粒度。障害対応中に読む文面なので「0 時間前」のような表示を許さない。
expect_output_matches '最古 2 時間前'
t_end

# **本命 1**: 7 日停止の最中に新規マージが入った状態。main HEAD の経過時間で判定していると
# 「HEAD は 5 分前だから猶予内」で緑に戻ってしまう。最古基準ならそうならない。
t_begin 'check-prod-image-drift: 7日停止中に新規マージが入っても緑に戻らない（#91 の本命）'
pid_fixture
pid_snapshot "$(pid_short "$PID_C1" 7)"
pid_run
expect_red 'behind'
# 7 日分は「168 時間」ではなく「7 日」と出す。
expect_output_matches '最古 7 日前'
t_end

# **本命 2**: feature ブランチの古い committer date で誤報しないこと。
# 素の rev-list で最古を測ると、3 時間前に書かれたコミットを 4 分前にマージしただけで赤になる。
t_begin 'check-prod-image-drift: 古いコミットを含む PR を直近にマージしても誤報しない'
pid_fixture
git -C "${FX}/repo" checkout -q -b feat "$PID_C4"
echo feature > "${FX}/repo/g.txt"
git -C "${FX}/repo" add g.txt
GIT_AUTHOR_DATE="@$((PID_NOW - 10800)) +0000" GIT_COMMITTER_DATE="@$((PID_NOW - 10800)) +0000" \
  git -C "${FX}/repo" commit -q -m 'f1（3 時間前に書かれた）'
git -C "${FX}/repo" checkout -q main
GIT_AUTHOR_DATE="@$((PID_NOW - 240)) +0000" GIT_COMMITTER_DATE="@$((PID_NOW - 240)) +0000" \
  git -C "${FX}/repo" merge -q --no-ff feat -m 'Merge pull request #99 from feat'
git -C "${FX}/repo" update-ref refs/remotes/origin/main "$(git -C "${FX}/repo" rev-parse HEAD)"
pid_snapshot "$(pid_short "$PID_C4" 7)"
pid_run
expect_green
expect_output_matches 'in-flight'
t_end

# deploy.yml の Placeholder 稼働検出はサービスしか見ておらず、ジョブ 2 種は対象外だった。
t_begin 'check-prod-image-drift: ジョブが placeholder のままなら赤（deploy.yml が見ていない穴）'
pid_fixture
pid_snapshot "$(pid_short "$PID_C4" 7)"
{
  printf 'service\tweb\t%s/web:%s\t7\t7\tweb-00007-aaa\tweb-00007-aaa\tweb-00007-aaa\n' "$PID_BASE" "$(pid_short "$PID_C4" 7)"
  printf 'job\tbatch\tus-docker.pkg.dev/cloudrun/container/hello\t-\t-\t-\t-\t-\n'
} | fx_write snapshot.tsv
pid_run
expect_red 'placeholder'
t_end

# 対照: タグの桁数が変わっても（core.abbrev=auto で伸びる）同じ commit なら緑であること。
# 文字列比較していると 12 桁タグを別物と誤認する。
t_begin 'check-prod-image-drift: 短SHAの桁数が違っても同じ commit なら緑'
pid_fixture
pid_snapshot "$(pid_short "$PID_C4" 12)"
pid_run
expect_green
t_end

t_begin 'check-prod-image-drift: 新リビジョンが Ready にならず旧が配信され続けていたら赤'
pid_fixture
{
  printf 'service\tweb\t%s/web:%s\t8\t8\tweb-00007-aaa\tweb-00008-bbb\tweb-00007-aaa\n' "$PID_BASE" "$(pid_short "$PID_C4" 7)"
  printf 'job\tbatch\t%s/batch:%s\t-\t-\t-\t-\t-\n' "$PID_BASE" "$(pid_short "$PID_C4" 7)"
} | fx_write snapshot.tsv
pid_run
expect_red 'stuck'
t_end

# 実測 0 件のまま「乖離なし」で緑にするのが最悪の空振りである（今回の事故の再来になる）。
t_begin 'check-prod-image-drift: 稼働イメージを 1 件も取得できないとき緑を返さない（空振り防止）'
pid_fixture
printf '' | fx_write snapshot.tsv
pid_run
expect_red '1件も取得できませんでした'
# 早期異常でも署名を出すのが本スクリプトの契約。空のまま通知側へ渡ると「状態が変わっていない」
# 判定ができず、赤が続く限り実行のたびに追跡 Issue へコメントが増える。
expect_output_matches 'DRIFT-SIGNATURE: early-exit=snapshot-empty'
t_end

# 比較先を解決できないとき HEAD へ暗黙にフォールバックすると、別物と比較して緑になる。
t_begin 'check-prod-image-drift: 比較先を解決できないとき HEAD へ落ちずに赤になる'
pid_fixture
pid_snapshot "$(pid_short "$PID_C4" 7)"
PID_MAIN_REF=origin/nonexistent
pid_run
PID_MAIN_REF=''
expect_red 'fetch-depth: 0'
expect_output_matches 'DRIFT-SIGNATURE: early-exit=main-ref-unresolvable'
t_end

# 正典の供給が壊れたときも同様に署名を出す（通知のスパム防止は早期異常の経路でこそ効く）。
t_begin 'check-prod-image-drift: 正典が空でも署名を出してから落ちる'
pid_fixture
pid_snapshot "$(pid_short "$PID_C4" 7)"
printf '' | fx_write targets.tsv
pid_run
expect_red '対象集合を1件も取得できませんでした'
expect_output_matches 'DRIFT-SIGNATURE: early-exit=canon-empty'
t_end

# 猶予超過が 1 時間未満のときに「0 時間前」と出さないこと（Issue #102 の実測で発覚）。
t_begin 'check-prod-image-drift: 猶予超過が 1 時間未満でも分で表示する'
pid_fixture
pid_snapshot "$(pid_short "${PID_C4}~1" 7)"
PID_GRACE=1
pid_run
PID_GRACE=''
expect_red 'behind'
expect_output_matches '最古 5 分前'
expect_absent '0 時間前'
t_end

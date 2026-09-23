# scripts/check-store-serviceable-predicate.sh の自己テスト（Issue #252・store-suspension spec）。
#
# 本ガードは、確定店舗を選ぶ判定（確定の判定 A）を持つ本番コードのファイルごとに、
# 「停止中でない」の判定（停止の判定 B）が A 以上の件数あることを要求する。表示だけの A は
# ガード本体に宣言した 1 件の除外印でだけ数えから外せる。
#
# fixture は現行ツリーの形を縮めて写す。Go の 2 つのクエリ、店舗一覧画面の表示だけの判定と
# QR ボタンの判定、LIFF の読み出し（JSDoc と SQL の `--` コメントが A を引用する）、
# 客向けアンケートの判定（`[storeId]` の角括弧を含むパス）である。さらに A を持つテスト・
# e2e・生成物を置き、除外が効いていなければ緑の基準ケースが赤くなるようにしてある。
#
# 変異は fixture のファイルへ perl で当て、**当たったことを必ず assert する**（空振りした変異は
# 無改変の fixture を検査することになり、赤を「検出できた」と誤読する）。

sp_fixture() {
  fx_guard check-store-serviceable-predicate

  fx_write go/internal/repo/stores.go <<'EOF'
package repo

// ConfirmedStores は place_status='confirmed' かつ停止中でない店舗を返す。
const confirmedStoresSQL = `
		SELECT id FROM stores
		WHERE place_status = 'confirmed'
		  AND suspended_at IS NULL`

const withoutCompetitorsSQL = `
		SELECT s.id FROM stores s
		WHERE s.place_status = 'confirmed'
		  AND s.suspended_at IS NULL`
EOF

  fx_write ts/apps/dashboard-web/src/app/stores/page.tsx <<'EOF'
export function Row({ store }: { store: Store }) {
  return (
    <tr>
      <td>
        {/* serviceable-predicate: display-only（確定済み／未確定の表示だけで、利用可否を決めない） */}
        {store.placeStatus === 'confirmed' ? '確定済み' : '未確定'}
      </td>
      <td>
        {store.placeStatus === 'confirmed' && store.suspendedAt === null ? (
          <button>QR 発行</button>
        ) : null}
      </td>
    </tr>
  );
}
EOF

  fx_write ts/apps/store-detail/lib/liff-auth.ts <<'EOF'
/** owner は存在するが、place_status='confirmed' の店舗が 1 件も無い（オンボーディング未完了）。 */
export const ownerStoresSql = `
      -- 確定済みかつ利用中 place_status = 'confirmed' の店舗だけを返す
      SELECT id FROM stores
      WHERE owner_id = $1 AND place_status = 'confirmed'
        AND suspended_at IS NULL
      ORDER BY created_at ASC`;
EOF

  fx_write 'ts/apps/survey-web/src/app/s/[storeId]/page-data.ts' <<'EOF'
export function availability(store: SurveyStore | null): 'available' | 'unavailable' {
  if (!store || store.placeStatus !== 'confirmed' || store.suspendedAt !== null) {
    return 'unavailable';
  }
  return 'available';
}
EOF

  fx_write ts/packages/db/src/other.ts <<'EOF'
export const unrelated = 1;
EOF

  # 空のファイル（判定を持ち得ない。件数の照合を食い違わせないことの確認）。
  : > "${FX}/ts/packages/db/src/empty.ts"

  # --- 除外されるべきファイル（どれも A を持ち、B を持たない） ------------------------
  fx_write go/internal/repo/stores_test.go <<'EOF'
package repo

const seed = `SELECT id FROM stores WHERE place_status = 'confirmed'`
EOF
  fx_write ts/apps/survey-web/test/page-data.test.ts <<'EOF'
expect(store.placeStatus === 'confirmed').toBe(true);
EOF
  fx_write ts/apps/dashboard-web/e2e/stores.ts <<'EOF'
const confirmed = (s: Store) => s.placeStatus === 'confirmed';
EOF
  fx_write ts/apps/dashboard-web/next-env.d.ts <<'EOF'
declare const generated: "place_status = 'confirmed'" extends string ? true : false;
const x = store.placeStatus === 'confirmed';
EOF
  fx_write ts/packages/db/dist/stores.ts <<'EOF'
const q = `SELECT id FROM stores WHERE place_status = 'confirmed'`;
EOF
}

sp_mutate() {
  # $1 = fixture 相対パス / $2 = perl の式。当たらなければ即失敗させる。
  sp_path="${FX}/$1"
  cp "$sp_path" "${sp_path}.orig"
  perl -pe "$2" "${sp_path}.orig" > "$sp_path"
  assert_count=$((assert_count + 1))
  if cmp -s "${sp_path}.orig" "$sp_path"; then
    _t_fail "変異が 1 箇所も当たりませんでした（$1: $2）。無改変の fixture を検査するところでした。"
    rm -f "${sp_path}.orig"
    return 1
  fi
  rm -f "${sp_path}.orig"
  return 0
}

sp_expect_fixture_count() {
  # $1 = fixture 相対パス / $2 = 固定文字列 / $3 = 期待する件数。fixture 自身の自己検証に使う。
  assert_count=$((assert_count + 1))
  sp_rc=0
  sp_n="$(grep -cF -- "$2" "${FX}/$1")" || sp_rc=$?
  if [ "$sp_rc" -gt 1 ]; then
    _t_fail "fixture を検査できません（grep exit=${sp_rc}）: $1"
    return
  fi
  if [ "${sp_n:-0}" -ne "$3" ]; then
    _t_fail "fixture ${1} の「${2}」は ${3} 件のはずが ${sp_n:-0} 件でした。"
  fi
}

SP_MARKER='serviceable-predicate: display-only（確定済み／未確定の表示だけで、利用可否を決めない）'

# ---------------------------------------------------------------------------

t_begin 'check-store-serviceable-predicate: 全ファイルで停止の判定が足り、印が宣言どおりなら緑（件数まで照合）'
sp_fixture
fx_run check-store-serviceable-predicate
expect_green
# **件数まで固定する。** コメント行・テスト・生成物の除外が崩れると A の総数が増え、
# 空のファイルの扱いが崩れると走査ファイル数が変わる。
expect_output_matches 'OK: 確定の判定 6 件（うち display-only の印 1 件）/ 停止の判定 5 件 / 走査 5 ファイル（空のファイル 1 件を除く）— 印の無い確定の判定を持つ 4 ファイルすべて'
expect_output_matches '^  ts/apps/store-detail/lib/liff-auth\.ts: 確定の判定 1（印 0）/ 停止の判定 1$'
expect_output_matches '^  ts/apps/dashboard-web/src/app/stores/page\.tsx: 確定の判定 2（印 1）/ 停止の判定 1$'
expect_output_matches '^  ts/apps/survey-web/src/app/s/\[storeId\]/page-data\.ts: 確定の判定 1（印 0）/ 停止の判定 1$'
expect_absent 'stores_test.go'
expect_absent 'page-data.test.ts'
expect_absent 'e2e/stores.ts'
expect_absent 'next-env.d.ts'
expect_absent 'dist/stores.ts'
t_end

t_begin 'check-store-serviceable-predicate: 停止の判定を 1 つ消すと赤（そのファイルを名指しする）'
sp_fixture
sp_mutate go/internal/repo/stores.go 's/^\t\t  AND s\.suspended_at IS NULL`$/\t\t`/'
fx_run check-store-serviceable-predicate
expect_red '停止の判定が足りないファイルがあります'
expect_output_matches '^  go/internal/repo/stores\.go: 印の無い確定の判定 2 件に対し、停止の判定 1 件$'
expect_absent 'liff-auth.ts: 印の無い'
t_end

t_begin 'check-store-serviceable-predicate: 理由の無い印は赤'
sp_fixture
sp_mutate ts/apps/dashboard-web/src/app/stores/page.tsx "s/\Q${SP_MARKER}\E/serviceable-predicate: display-only/"
fx_run check-store-serviceable-predicate
expect_red '理由の無い display-only の印があります'
expect_output_matches '^  ts/apps/dashboard-web/src/app/stores/page\.tsx:5$'
# 印の件数そのものは宣言どおり（1 件）なので、食い違いとしては報告しない。
expect_absent '印の数が宣言と食い違っています'
t_end

t_begin 'check-store-serviceable-predicate: 括弧だけで中身が空白の理由も赤'
sp_fixture
sp_mutate ts/apps/dashboard-web/src/app/stores/page.tsx "s/\Q${SP_MARKER}\E/serviceable-predicate: display-only（  ）/"
fx_run check-store-serviceable-predicate
expect_red '理由の無い display-only の印があります'
t_end

t_begin 'check-store-serviceable-predicate: 宣言外のファイルの印は赤（印の総数は宣言どおりでも）'
sp_fixture
# 印を店舗一覧の画面から客向けアンケートの判定へ移す。総数は 1 のまま変わらない。
sp_mutate ts/apps/dashboard-web/src/app/stores/page.tsx "s/^.*\Q${SP_MARKER}\E.*\n//"
sp_mutate 'ts/apps/survey-web/src/app/s/[storeId]/page-data.ts' "s{^(  if \(!store \|\| store\.placeStatus)}{  // ${SP_MARKER}\n\$1}"
sp_expect_fixture_count 'ts/apps/survey-web/src/app/s/[storeId]/page-data.ts' 'serviceable-predicate: display-only' 1
fx_run check-store-serviceable-predicate
expect_red '宣言外のファイルに display-only の印があります'
expect_output_matches '^  ts/apps/survey-web/src/app/s/\[storeId\]/page-data\.ts:2$'
expect_absent '印の数が宣言と食い違っています'
t_end

t_begin 'check-store-serviceable-predicate: 宣言数を超える印は赤（件数の不足としては出ない）'
sp_fixture
sp_mutate ts/apps/dashboard-web/src/app/stores/page.tsx "s|^(        \{store\.placeStatus === 'confirmed' &&)|        {/* ${SP_MARKER} */}\n\$1|"
sp_expect_fixture_count ts/apps/dashboard-web/src/app/stores/page.tsx 'serviceable-predicate: display-only' 2
fx_run check-store-serviceable-predicate
expect_red 'display-only の印の数が宣言と食い違っています（宣言 1 件・実際 2 件）'
# 2 件の A がどちらも印で外れるため、このファイルの件数の不足は起きない（原因を取り違えない）。
expect_absent '停止の判定が足りないファイルがあります'
t_end

t_begin 'check-store-serviceable-predicate: 宣言した印を消すと赤（食い違いと件数の不足の両方）'
sp_fixture
sp_mutate ts/apps/dashboard-web/src/app/stores/page.tsx "s/^.*\Q${SP_MARKER}\E.*\n//"
sp_expect_fixture_count ts/apps/dashboard-web/src/app/stores/page.tsx 'serviceable-predicate' 0
fx_run check-store-serviceable-predicate
expect_red 'display-only の印の数が宣言と食い違っています（宣言 1 件・実際 0 件）'
expect_output_matches '^  ts/apps/dashboard-web/src/app/stores/page\.tsx: 印の無い確定の判定 2 件に対し、停止の判定 1 件$'
t_end

t_begin 'check-store-serviceable-predicate: どの判定も指さない印は赤'
sp_fixture
# 印を判定の 2 行上（`<td>` の前）へずらす。印の総数は 1 のまま。
sp_mutate ts/apps/dashboard-web/src/app/stores/page.tsx "s/^.*\Q${SP_MARKER}\E.*\n//"
sp_mutate ts/apps/dashboard-web/src/app/stores/page.tsx "s|^(    <tr>)\$|\$1\n      {/* ${SP_MARKER} */}|"
sp_expect_fixture_count ts/apps/dashboard-web/src/app/stores/page.tsx 'serviceable-predicate: display-only' 1
fx_run check-store-serviceable-predicate
expect_red '確定の判定を指していない display-only の印があります'
expect_output_matches '^  ts/apps/dashboard-web/src/app/stores/page\.tsx:4$'
expect_absent '印の数が宣言と食い違っています'
t_end

t_begin 'check-store-serviceable-predicate: 同じ行に置いた正しい印でも緑'
sp_fixture
sp_mutate ts/apps/dashboard-web/src/app/stores/page.tsx "s/^.*\Q${SP_MARKER}\E.*\n//"
sp_mutate ts/apps/dashboard-web/src/app/stores/page.tsx "s|'確定済み' : '未確定'\}|'確定済み' : '未確定' /* ${SP_MARKER} */}|"
fx_run check-store-serviceable-predicate
expect_green
expect_output_matches '^  ts/apps/dashboard-web/src/app/stores/page\.tsx: 確定の判定 2（印 1）/ 停止の判定 1$'
t_end

t_begin 'check-store-serviceable-predicate: コメント行だけにある停止の判定は数えない（赤）'
sp_fixture
sp_mutate ts/apps/store-detail/lib/liff-auth.ts 's/^        AND suspended_at IS NULL$/        -- AND suspended_at IS NULL/'
fx_run check-store-serviceable-predicate
expect_red '停止の判定が足りないファイルがあります'
expect_output_matches '^  ts/apps/store-detail/lib/liff-auth\.ts: 印の無い確定の判定 1 件に対し、停止の判定 0 件$'
t_end

t_begin 'check-store-serviceable-predicate: 確定の判定がコメント行だけなら 0 件として赤'
fx_guard check-store-serviceable-predicate
fx_write go/internal/repo/stores.go <<'EOF'
package repo

// ConfirmedStores は place_status = 'confirmed' の店舗を返す。
/* 対象は place_status='confirmed' だけ */
EOF
fx_write ts/apps/store-detail/lib/liff-auth.ts <<'EOF'
/**
 * placeStatus === 'confirmed' の店舗だけを返す。
 */
export const sql = `
  -- place_status = 'confirmed'
  SELECT 1`;
EOF
sp_expect_fixture_count go/internal/repo/stores.go "'confirmed'" 2
sp_expect_fixture_count ts/apps/store-detail/lib/liff-auth.ts "'confirmed'" 2
fx_run check-store-serviceable-predicate
expect_red '確定の判定が 1 件も見つかりません（走査 2 ファイル）'
t_end

t_begin 'check-store-serviceable-predicate: 確定の判定が 1 件も無ければ赤（抽出の空振り）'
fx_guard check-store-serviceable-predicate
fx_write ts/packages/db/src/other.ts <<'EOF'
export const unrelated = 1;
EOF
fx_run check-store-serviceable-predicate
expect_red '確定の判定が 1 件も見つかりません（走査 1 ファイル）'
t_end

t_begin 'check-store-serviceable-predicate: 除外の外に足した確定の判定は数える（射程の対照）'
sp_fixture
# テストの fixture と同じ中身を本番コードの位置へ置くと赤になる。基準ケースの緑が
# 「除外が効いているから」であって「そもそも読んでいないから」ではないことの対照。
fx_write ts/apps/survey-web/src/extra.ts <<'EOF'
export const confirmed = (s: Store) => s.placeStatus === 'confirmed';
EOF
fx_run check-store-serviceable-predicate
expect_red '停止の判定が足りないファイルがあります'
expect_output_matches '^  ts/apps/survey-web/src/extra\.ts: 印の無い確定の判定 1 件に対し、停止の判定 0 件$'
t_end

t_begin 'check-store-serviceable-predicate: 追跡下のファイルが読めなければ赤（射程を黙って痩せさせない）'
sp_fixture
fx_track_now
rm -f "${FX}/ts/packages/db/src/other.ts"
fx_run check-store-serviceable-predicate
expect_red '走査を評価できません（追跡下のファイルが読めません: ts/packages/db/src/other.ts）'
t_end

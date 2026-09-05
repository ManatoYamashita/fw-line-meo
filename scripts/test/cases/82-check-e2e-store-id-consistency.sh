# scripts/check-e2e-store-id-consistency.sh の自己テスト（Issue #53）。
#
# 本ガードが守るのは「役割の違う 4 箇所に現れる E2E の storeId が同じ値であること」である。
# ずれたときの症状は赤ではない —— とくに Lighthouse の URL がずれると、存在しない店舗の
# 1 段落だけの面を測って LCP も accessibility も緑を返す。**別の面を測ったまま合格する。**

esi_tree() {
  fx_guard check-e2e-store-id-consistency

  fx_write ts/apps/survey-web/e2e/seed.sql <<'EOF'
INSERT INTO owners (id, agency_id) VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;
INSERT INTO stores (id, owner_id, name, place_id, place_status)
  VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'E2E店', 'ChIJxxxx', 'confirmed') ON CONFLICT DO NOTHING;
EOF
  fx_write ts/apps/survey-web/e2e/fixtures/surfaces.ts <<'EOF'
export const STORE_ID = process.env.E2E_STORE_ID ?? '44444444-4444-4444-4444-444444444444';
EOF
  fx_write .github/workflows/ts-ci.yml <<'EOF'
name: ts-ci
jobs:
  e2e:
    env:
      E2E_STORE_ID: '44444444-4444-4444-4444-444444444444'
    steps:
      - run: echo ok
EOF
  fx_write ts/apps/survey-web/perf/lighthouserc.json <<'EOF'
{
  "ci": {
    "collect": {
      "url": ["http://127.0.0.1:3000/s/44444444-4444-4444-4444-444444444444"]
    }
  }
}
EOF
  fx_write docs/e2e-runbook.md <<'EOF'
ローカルで走らせる手順:

```bash
export E2E_STORE_ID="44444444-4444-4444-4444-444444444444"
```
EOF
}

t_begin 'check-e2e-store-id-consistency: 正常なツリーで緑（値と件数まで照合）'
esi_tree
fx_run check-e2e-store-id-consistency
expect_green
# 「OK」だけでなく照合できた件数まで見る。走査が空振りしたまま緑になる経路と区別するため。
expect_output_matches '役割 4 件が一致 44444444-4444-4444-4444-444444444444 / 既定値の宣言 1 件 / 手順書 1 件照合'
t_end

# ---------------------------------------------------------------------------
# 1. 役割ごとのずれ。3 経路それぞれで到達することを示す。

# **最も静かなずれ。** Lighthouse は存在しない店舗の URL を開き、1 段落だけの面に対して
# LCP も accessibility も緑を返す。
t_begin 'check-e2e-store-id-consistency: 計測（Lighthouse）の URL だけずれると赤'
esi_tree
fx_write ts/apps/survey-web/perf/lighthouserc.json <<'EOF'
{
  "ci": {
    "collect": {
      "url": ["http://127.0.0.1:3000/s/55555555-5555-5555-5555-555555555555"]
    }
  }
}
EOF
fx_run check-e2e-store-id-consistency
expect_red '計測（ts/apps/survey-web/perf/lighthouserc.json）の storeId が種と一致しません。'
t_end

t_begin 'check-e2e-store-id-consistency: 注入（CI の env）だけずれると赤'
esi_tree
fx_write .github/workflows/ts-ci.yml <<'EOF'
name: ts-ci
jobs:
  e2e:
    env:
      E2E_STORE_ID: '77777777-7777-7777-7777-777777777777'
    steps:
      - run: echo ok
EOF
fx_run check-e2e-store-id-consistency
expect_red '注入（.github/workflows/ts-ci.yml）の storeId が種と一致しません。'
t_end

t_begin 'check-e2e-store-id-consistency: 既定（fixtures）だけずれると赤'
esi_tree
fx_write ts/apps/survey-web/e2e/fixtures/surfaces.ts <<'EOF'
export const STORE_ID = process.env.E2E_STORE_ID ?? '88888888-8888-8888-8888-888888888888';
EOF
fx_run check-e2e-store-id-consistency
expect_red '既定（ts/apps/survey-web/e2e/fixtures/surfaces.ts）の storeId が種と一致しません。'
t_end

# ---------------------------------------------------------------------------
# 2. 既定値の複写。**本ガードを入れた直接の動機**（PR #191 時点の状態）。
#    env が渡っている限り値は一致するため、複写であること自体が観測できない。

t_begin 'check-e2e-store-id-consistency: 既定値の宣言が 2 箇所あると赤'
esi_tree
fx_write ts/apps/survey-web/e2e/survey-flow.spec.ts <<'EOF'
const STORE_ID = process.env.E2E_STORE_ID ?? '44444444-4444-4444-4444-444444444444';
export default STORE_ID;
EOF
fx_run check-e2e-store-id-consistency
expect_red '既定値の宣言（process.env.E2E_STORE_ID ??）が 2 件あります（1 件であるべきです）'
t_end

# ---------------------------------------------------------------------------
# 3. 抽出の前提が崩れたときに赤くなること。
#
# **このケースは実際にバグを 1 件捕まえている。** 抽出関数はコマンド置換（副シェル）で
# 呼ばれるため、関数の中で fail=1 を立てても親へ戻らない。最初の実装はまさにその形で、
# ERROR を stderr へ出しながら exit 0 を返していた（健全な実行と見分けが付かない偽の緑）。
# expect_red は exit != 0 を要求するので、この形の再発はここで止まる。

t_begin 'check-e2e-store-id-consistency: 種の抽出前提が崩れると赤（exit も非ゼロ）'
esi_tree
fx_write ts/apps/survey-web/e2e/seed.sql <<'EOF'
INSERT INTO shops (id, owner_id, name, place_id, place_status)
  VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'E2E店', 'ChIJxxxx', 'confirmed') ON CONFLICT DO NOTHING;
EOF
fx_run check-e2e-store-id-consistency
expect_red '種: ts/apps/survey-web/e2e/seed.sql から storeId を抽出できませんでした。'
t_end

t_begin 'check-e2e-store-id-consistency: 種が 2 件取れると赤（正典が決まらない）'
esi_tree
fx_write ts/apps/survey-web/e2e/seed.sql <<'EOF'
INSERT INTO stores (id, owner_id, name, place_id, place_status)
  VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'E2E店', 'ChIJxxxx', 'confirmed');
INSERT INTO stores (id, owner_id, name, place_id, place_status)
  VALUES ('99999999-9999-9999-9999-999999999999', '33333333-3333-3333-3333-333333333333', 'E2E店2', 'ChIJyyyy', 'confirmed');
EOF
fx_run check-e2e-store-id-consistency
expect_red 'から storeId が 2 件取れました（どれが正典か決まりません）。'
t_end

# ---------------------------------------------------------------------------
# 4. 手順書の照合。**あれば照合し、無くても緑**（文書を消しただけで赤くなるのは行き過ぎ）。

t_begin 'check-e2e-store-id-consistency: 手順書の値が古いと赤'
esi_tree
fx_write docs/e2e-runbook.md <<'EOF'
ローカルで走らせる手順:

```bash
export E2E_STORE_ID="66666666-6666-6666-6666-666666666666"
```
EOF
fx_run check-e2e-store-id-consistency
expect_red 'docs/e2e-runbook.md の手順が古い storeId を指示しています'
t_end

t_begin 'check-e2e-store-id-consistency: 手順書が無くても緑（存在までは要求しない）'
esi_tree
fx_write docs/e2e-runbook.md <<'EOF'
ローカルで走らせる手順は CI のワークフローを参照すること。
EOF
fx_run check-e2e-store-id-consistency
expect_green
expect_output_matches '手順書 0 件照合'
t_end

# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-cloud-run-reserved-paths.sh の自己テスト（Issue #219）。
#
# 本ガードが守るのは「Cloud Run が予約する URL パスをルートにしない」である。破れたときの
# 症状は赤ではなく **本番だけの 404** で、ローカルの standalone 起動でも E2E でも 200 が返る。
# 404 を返すのはコンテナの手前の Google Frontend なので、アプリのログにも何も残らない。
# `/healthz` がこの形で全 5 サービスとも本番で到達不能だった。
#
# 射程の下限も固定する。テストが組み立てる検証用アプリ、非公開フォルダ（`_` で始まる）、
# 動的セグメントで終わる経路は巻き込まない。射程を広げる改変が入ったら、それらを置いた
# 緑ケースが赤くなって気づけるようにしてある。

crp_tree() {
  fx_guard check-cloud-run-reserved-paths

  # Hono 形式: ルート定義 2 件。
  fx_write ts/apps/api/src/app.ts <<'EOF'
import { Hono } from 'hono';

export function createApp(): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.post('/webhook', async (c) => c.text('ok'));
  return app;
}
EOF

  # テストが組み立てる検証用アプリは本番へ出ない。**素通しされなければならない。**
  # 除外は 2 経路（test/ ディレクトリ・*.test.ts の名前）あり、片方だけでは届かない
  # ファイルをそれぞれ置く。両方を満たす 1 ファイルだけだと、片方の除外を消しても
  # もう片方が守ってしまい、消えたことに気づけない（変異実験で実際にそうなった）。
  fx_write ts/apps/api/test/helpers/fake-app.ts <<'EOF'
import { Hono } from 'hono';

export function fakeApp(): Hono {
  const app = new Hono();
  app.get('/fooz', (c) => c.text('x'));
  return app;
}
EOF
  fx_write ts/apps/api/src/routes.test.ts <<'EOF'
import { Hono } from 'hono';

it('検証用のルート', async () => {
  const app = new Hono();
  app.get('/barz', (c) => c.text('x'));
  await app.request('/barz');
});
EOF

  # Next.js App Router: 公開される route / page が 4 件。
  fx_write ts/apps/web/src/app/health/route.ts <<'EOF'
export function GET(): Response {
  return Response.json({ status: 'ok' });
}
EOF
  # ルートグループ `(ops)` は URL に現れない → /status
  fx_write ts/apps/web/src/app/'(ops)'/status/page.tsx <<'EOF'
export default function Page() {
  return <p>status</p>;
}
EOF
  # src/ を持たない配置 → /store
  fx_write ts/apps/detail/app/store/page.tsx <<'EOF'
export default function Page() {
  return <p>store</p>;
}
EOF
  # 途中のセグメントが z で終わっても、パスの末尾は動的セグメント → /quiz/[id]
  fx_write ts/apps/detail/app/quiz/'[id]'/page.tsx <<'EOF'
export default function Page() {
  return <p>quiz</p>;
}
EOF
  # 非公開フォルダ（`_` 始まり）は URL にならない。**数えも咎めもしない。**
  fx_write ts/apps/detail/app/_lib/fooz/route.ts <<'EOF'
export function GET(): Response {
  return new Response('internal');
}
EOF
}

t_begin 'check-cloud-run-reserved-paths: 予約パスが無ければ緑（件数まで照合）'
crp_tree
fx_run check-cloud-run-reserved-paths
expect_green
# 件数を照合する。非公開フォルダとテストを数えず、ルートグループと src/ 有無の両配置を
# 数えていることの証拠になる（走査が空振りしたまま緑になる経路とも区別できる）。
expect_output_matches 'Hono 形式 2 件 / Next\.js 4 件検証'
t_end

t_begin 'check-cloud-run-reserved-paths: Hono の /healthz は赤'
crp_tree
fx_write ts/apps/api/src/app.ts <<'EOF'
import { Hono } from 'hono';

export function createApp(): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.post('/webhook', async (c) => c.text('ok'));
  return app;
}
EOF
fx_run check-cloud-run-reserved-paths
expect_red 'Cloud Run が予約する URL パスを使っています'
expect_output_matches '^  ts/apps/api/src/app\.ts:5:'
t_end

t_begin 'check-cloud-run-reserved-paths: Hono の /_ah/ 始まり・二重引用符の z 終わりも赤'
crp_tree
fx_write ts/apps/api/src/app.ts <<'EOF'
import { Hono } from 'hono';

export function createApp(): Hono {
  const app = new Hono();
  app.get('/_ah/warmup', (c) => c.text('ok'));
  app.get("/statusz", (c) => c.text('ok'));
  return app;
}
EOF
fx_run check-cloud-run-reserved-paths
expect_red 'Cloud Run が予約する URL パスを使っています'
expect_output_matches '^  ts/apps/api/src/app\.ts:5:'
expect_output_matches '^  ts/apps/api/src/app\.ts:6:'
t_end

t_begin 'check-cloud-run-reserved-paths: Next.js の app/healthz/route.ts は赤'
crp_tree
fx_write ts/apps/detail/app/healthz/route.ts <<'EOF'
export function GET(): Response {
  return Response.json({ status: 'ok' });
}
EOF
fx_run check-cloud-run-reserved-paths
expect_red 'Cloud Run が予約する URL パスを使っています'
expect_output_matches '^  ts/apps/detail/app/healthz/route\.ts → /healthz$'
t_end

# ルートグループを外してから末尾を見ていることの固定。**グループを末尾に置く。**
# `livez/(internal)/route.ts` の URL は /livez だが、グループ名ごと末尾と読むと `)` で
# 終わるため取り逃がす。グループを途中に置く形（`(ops)/livez`）では、除去の有無に
# かかわらず末尾が livez になり、この分岐を検査できない（実際にそれで空振りしていた）。
t_begin 'check-cloud-run-reserved-paths: ルートグループを外した URL の末尾 z も赤'
crp_tree
fx_write ts/apps/web/src/app/livez/'(internal)'/route.ts <<'EOF'
export function GET(): Response {
  return new Response('ok');
}
EOF
fx_run check-cloud-run-reserved-paths
expect_red 'Cloud Run が予約する URL パスを使っています'
expect_output_matches '→ /livez$'
t_end

# 空振り防止。対象 0 件は「守っている」ではなく「何も見ていない」。走査の片方だけが
# 壊れても全体の件数では気づけないので、2 系統を別々に要求する。
t_begin 'check-cloud-run-reserved-paths: Hono 形式が 0 件なら赤（空振り防止）'
crp_tree
fx_write ts/apps/api/src/app.ts <<'EOF'
export const unused = 1;
EOF
fx_run check-cloud-run-reserved-paths
expect_red 'Hono 形式の path リテラルが 1 件も見つかりません'
t_end

t_begin 'check-cloud-run-reserved-paths: Next.js の route / page が 0 件なら赤（空振り防止）'
fx_guard check-cloud-run-reserved-paths
fx_write ts/apps/api/src/app.ts <<'EOF'
import { Hono } from 'hono';

export function createApp(): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok' }));
  return app;
}
EOF
fx_run check-cloud-run-reserved-paths
expect_red 'Next.js の route / page が 1 件も見つかりません'
t_end

# grep が評価不能（exit 2）のとき、無一致（exit 1）と同一視して緑を返してはならない。
# **落とすのは走査の grep だけ**にする。件数を数える `grep -c ''` まで落とすと、
# 走査の分岐へ到達したのかどうかが判別できなくなる。
t_begin 'check-cloud-run-reserved-paths: grep が評価不能なら赤（無一致と混同しない）'
crp_tree
crp_real_grep="$(PATH="$FX_BASE_PATH" command -v grep)"
cat > "${STUB_DIR}/grep" <<STUB
#!/usr/bin/env bash
case "\$*" in
  *'--include=*.ts'*) echo "grep-stub: simulated read error" >&2; exit 2 ;;
esac
exec "${crp_real_grep}" "\$@"
STUB
chmod +x "${STUB_DIR}/grep"
fx_run check-cloud-run-reserved-paths
expect_red '走査を評価できません'
t_end

# find が途中で失敗したとき、得られた一部だけで緑を返してはならない。
t_begin 'check-cloud-run-reserved-paths: find が失敗したら赤（部分結果で緑にしない）'
crp_tree
crp_real_find="$(PATH="$FX_BASE_PATH" command -v find)"
cat > "${STUB_DIR}/find" <<STUB
#!/usr/bin/env bash
"${crp_real_find}" "\$@"
echo "find-stub: simulated permission denied" >&2
exit 1
STUB
chmod +x "${STUB_DIR}/find"
fx_run check-cloud-run-reserved-paths
expect_red '列挙を評価できません'
t_end

#!/usr/bin/env bash
# Issue #91 再発防止ガードレール: 本番 Cloud Run の稼働イメージと main の乖離を検出する。
#
# 2026-08-02〜08-09、課金失効で deploy-prod が 6 回連続失敗し、本番 7 コンポーネントが旧イメージの
# まま 7 日間放置された。気づけなかった理由は 2 段構え:
#   (1) deploy-prod は workflow_run 起動のため PR のチェック欄に現れない
#   (2) deploy-prod はマージ契機でしか動かないので、main が動かない期間は run 自体が生成されず、
#       「失敗」という兆候すら出ない（実際 08-02〜08-08 はマージが 1 件も無かった）
# 本スクリプトは (2) を埋める。マージではなく時間で回し、稼働実態と main を突き合わせる。原因
# （#33 配線漏れ / #35 対象外 / #87 課金失効）は毎回違うが、気づけない構造は同じであり、稼働実態
# との照合は原因に依存しない唯一の網である。
#
# 検証内容（read-only。git と gcloud の読み取りのみで副作用なし）:
#   1. 対象集合は check-deploy-image-coverage.sh --print-targets から引く（列挙の二重管理を作らない）
#   2. 各コンポーネントの稼働イメージのタグを git オブジェクトへ解決し、main の HEAD と照合する
#   3. サービスは加えて「spec の更新が実配信まで収束しているか」を検証する（下記）
#   4. 正典とクラウドの集合・種別の不一致（missing / unmanaged / kind-mismatch）を検出する
#
# 設計上の要点:
#   - **短 SHA の文字列比較をしない。** `git rev-parse --short` は桁数を固定しない（core.abbrev=auto）
#     ため、`369a6c6` と `369a6c6f` が将来混在し得る。タグを git オブジェクトへ解決してから
#     merge-base で比較すれば桁数に依存しない。
#   - **猶予は「未デプロイのうち main の幹へ最も古く着地したものの経過時間」で判定する。**
#     main HEAD の経過時間で判定すると、7 日停止している最中に誰かが新規マージした瞬間に緑へ戻る
#     という致命的な穴がある。最古基準なら最古の未デプロイが 7 日前のままなので緑にならず、一度
#     赤くなったら新規マージでは緑に戻らない単調性も得られる。
#     ただし**素の rev-list で最古を取ってはいけない**。feature ブランチ上のコミットは committer
#     date が古いまま main へマージされるため、「3 時間前に書いたコミットを 4 分前にマージした」
#     だけで猶予超過と誤報する（2026-08-09 の PR #92 マージで実測）。`--first-parent` で main の
#     幹だけを辿れば、マージコミットの committer date = 着地時刻になる。
#     判定はコンポーネントごとに行う（deploy-prod が途中で落ちると一部だけ HEAD という混在状態に
#     なるため）。
#   - **タグ照合は spec のイメージで行い、実配信の担保は「収束状態」で取る。**
#     `gcloud run services update --image` は spec を更新して新リビジョンを作るが、そのリビジョンが
#     Ready にならなければトラフィックは旧リビジョンに流れ続ける。spec だけ見ると「反映済み」に見えて
#     実体は旧イメージという、本 Issue が潰したい無音障害そのものになる。
#     ところが **Cloud Run のリビジョンはイメージを digest に解決して保持しており、タグを保持しない**
#     （実測: revision の spec.containers[0].image も status.imageDigest も `…@sha256:…` 形式で、
#     client.knative.dev/user-image のようなタグ由来の annotation も無い）。したがってリビジョン側の
#     イメージを main の短 SHA と直接照合することはできない。Artifact Registry へ digest→tag を
#     引きに行けば可能だが、API と権限を増やす割に得るものが同じである。
#     代わりに、サービスの収束状態そのものを見る（services list の 1 コールで取れる）:
#       latestReadyRevisionName が空          → Ready なリビジョンが無い
#       latestCreated != latestReady          → 新リビジョンが Ready にならず旧イメージが配信中
#       generation != observedGeneration      → spec 更新がまだ反映されていない
#       traffic の宛先 != latestReady          → トラフィックが固定され最新が配信されていない
#     いずれも「spec は新しいのに配信は追いついていない」を捉える。前提: infra/modules/run-services は
#     traffic ブロックを持たず（既定 100% LATEST）、CI も --image しか打たない。
#   - **ジョブにはリビジョンもトラフィックも無い**ので spec.template…image が唯一の正。
#
# 使い方: bash scripts/check-prod-image-drift.sh
#   乖離があれば該当を stderr に出して exit 1、無ければ exit 0。
#   PROJECT_ID は必須（既定値を置かない。誤ったレジストリと比較して緑になるのを防ぐため）。
#
# 環境変数（既定はすべて本番挙動）:
#   PROJECT_ID            GCP プロジェクト ID。**必須**
#   REGION                既定 asia-northeast1
#   REPOSITORY            既定 fwlm
#   IMAGE_BASE            既定 ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}
#   DRIFT_MAIN_REF        既定 origin/main。解決できなければ hard fail（HEAD へ暗黙に落ちない）
#   DRIFT_GRACE_MINUTES   既定 90（実測 ts-ci 約 3 分 + deploy-prod 約 7 分の 9 倍マージン）
#   DRIFT_TARGETS_FILE    正典の注入。未設定なら check-deploy-image-coverage.sh --print-targets
#   PROD_IMAGE_SNAPSHOT   クラウド実測の注入。未設定なら gcloud を 3 回叩く
#   DRIFT_REPO_DIR        git 参照先。既定はこのリポジトリ
#   DRIFT_NOW_EPOCH       現在時刻（epoch 秒）。猶予の決定的テスト用
#
# snapshot の形式（TSV 8 列・`#` 始まりと空行は読み飛ばす）:
#   <kind>\t<name>\t<spec_image>\t<generation>\t<observed_generation>\t<latest_ready>\t<latest_created>\t<traffic>
#     kind        : service | job
#     spec_image  : サービスは spec.template…image / ジョブは spec.template.spec.template…image
#     4〜8 列目   : サービスの収束状態。ジョブは全て `-`。latest_ready が空なら NONE
#   live 収集もこの 8 列を組み立ててから比較へ渡す。live と fixture が完全に同一経路を通る。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-asia-northeast1}"
REPOSITORY="${REPOSITORY:-fwlm}"
DRIFT_MAIN_REF="${DRIFT_MAIN_REF:-origin/main}"
DRIFT_GRACE_MINUTES="${DRIFT_GRACE_MINUTES:-90}"
DRIFT_TARGETS_FILE="${DRIFT_TARGETS_FILE:-}"
PROD_IMAGE_SNAPSHOT="${PROD_IMAGE_SNAPSHOT:-}"
DRIFT_REPO_DIR="${DRIFT_REPO_DIR:-$ROOT}"
DRIFT_NOW_EPOCH="${DRIFT_NOW_EPOCH:-}"

if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: PROJECT_ID が未設定です。" >&2
  echo "       → 既定値を置くと誤ったレジストリのイメージと比較して緑になり得るため、明示を必須にしています。" >&2
  exit 1
fi
IMAGE_BASE="${IMAGE_BASE:-${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}}"

# `printf | grep -q` は SIGPIPE × pipefail で入力サイズ依存の偽陽性を生むため、
# 本スクリプトでは判定にパイプを使わない（case か grep -c で行う）。
case "$DRIFT_GRACE_MINUTES" in
  ''|*[!0-9]*)
    echo "ERROR: DRIFT_GRACE_MINUTES が数値ではありません: ${DRIFT_GRACE_MINUTES}" >&2
    exit 1
    ;;
esac
grace_seconds=$((DRIFT_GRACE_MINUTES * 60))

now_epoch="$DRIFT_NOW_EPOCH"
if [ -z "$now_epoch" ]; then
  now_epoch="$(date +%s)"
fi

# 注入モードの明示（fixture 実行を本番の緑と誤読させないため）。
injected=""
if [ -n "$PROD_IMAGE_SNAPSHOT" ]; then injected="${injected}PROD_IMAGE_SNAPSHOT "; fi
if [ -n "$DRIFT_TARGETS_FILE" ]; then injected="${injected}DRIFT_TARGETS_FILE "; fi
if [ -n "$DRIFT_NOW_EPOCH" ]; then injected="${injected}DRIFT_NOW_EPOCH "; fi
if [ "$DRIFT_REPO_DIR" != "$ROOT" ]; then injected="${injected}DRIFT_REPO_DIR "; fi
injected_note=""
if [ -n "$injected" ]; then
  echo "WARNING: 注入モードで実行中です（本番の実測ではありません）: ${injected}" >&2
  injected_note="（注入モード）"
fi

# ---------------------------------------------------------------------------
# 1. 対象集合（正典）
# ---------------------------------------------------------------------------
if [ -n "$DRIFT_TARGETS_FILE" ]; then
  if [ ! -f "$DRIFT_TARGETS_FILE" ]; then
    echo "ERROR: DRIFT_TARGETS_FILE が見つかりません: ${DRIFT_TARGETS_FILE}" >&2
    exit 1
  fi
  targets="$(cat "$DRIFT_TARGETS_FILE")"
else
  # --print-targets は検証を完走させた上で TSV を出す。検証が赤なら 1 行も出さず exit 1 するので、
  # 「壊れた正典で緑」にはならない。
  if ! targets="$(bash "${ROOT}/scripts/check-deploy-image-coverage.sh" --print-targets)"; then
    echo "ERROR: 対象集合の正典（check-deploy-image-coverage.sh）が赤のため、ドリフト検証を打ち切りました。" >&2
    echo "       → 先にデプロイパイプラインのカバレッジを是正してください（上記のエラー参照）。" >&2
    exit 1
  fi
fi

target_count="$(printf '%s\n' "$targets" | grep -cE '^(service|job)	[a-z0-9-]+$' || true)"
if [ "$target_count" -eq 0 ]; then
  echo "ERROR: 対象集合を1件も取得できませんでした（正典の供給が壊れています）。" >&2
  echo "       → 対象 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. クラウド実測（snapshot）
# ---------------------------------------------------------------------------
collect_live_snapshot() {
  # gcloud の失敗を握り潰さない。課金失効時は list 自体が失敗し、$(...) の中なら空文字が返って
  # 「対象 0 件で緑」になる = 今回の事故の再来。終了コードと行数の両方で塞ぐ。
  local svc_csv job_csv line name spec_image gen obs ready created traffic

  if ! svc_csv="$(gcloud run services list --region="$REGION" --project="$PROJECT_ID" \
    --format='csv[no-heading](metadata.name,spec.template.spec.containers[0].image,metadata.generation,status.observedGeneration,status.latestReadyRevisionName,status.latestCreatedRevisionName,status.traffic.revisionName)')"; then
    echo "ERROR: gcloud run services list に失敗しました（課金・認証・権限を確認してください）。" >&2
    return 1
  fi
  if ! job_csv="$(gcloud run jobs list --region="$REGION" --project="$PROJECT_ID" \
    --format='csv[no-heading](metadata.name,spec.template.spec.template.spec.containers[0].image)')"; then
    echo "ERROR: gcloud run jobs list に失敗しました。" >&2
    return 1
  fi

  if [ -z "$svc_csv" ] && [ -z "$job_csv" ]; then
    echo "ERROR: Cloud Run のサービス・ジョブを1件も取得できませんでした（プロジェクト／リージョンの指定を確認してください）。" >&2
    return 1
  fi

  printf '%s\n' "$svc_csv" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="$(printf '%s' "$line" | cut -d, -f1)"
    spec_image="$(printf '%s' "$line" | cut -d, -f2)"
    gen="$(printf '%s' "$line" | cut -d, -f3)"
    obs="$(printf '%s' "$line" | cut -d, -f4)"
    ready="$(printf '%s' "$line" | cut -d, -f5)"
    created="$(printf '%s' "$line" | cut -d, -f6)"
    traffic="$(printf '%s' "$line" | cut -d, -f7-)"
    [ -n "$ready" ] || ready="NONE"
    [ -n "$created" ] || created="NONE"
    [ -n "$traffic" ] || traffic="NONE"
    printf 'service\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$name" "$spec_image" "$gen" "$obs" "$ready" "$created" "$traffic"
  done

  printf '%s\n' "$job_csv" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="$(printf '%s' "$line" | cut -d, -f1)"
    spec_image="$(printf '%s' "$line" | cut -d, -f2)"
    printf 'job\t%s\t%s\t-\t-\t-\t-\t-\n' "$name" "$spec_image"
  done
}

if [ -n "$PROD_IMAGE_SNAPSHOT" ]; then
  if [ ! -f "$PROD_IMAGE_SNAPSHOT" ]; then
    echo "ERROR: PROD_IMAGE_SNAPSHOT が見つかりません: ${PROD_IMAGE_SNAPSHOT}" >&2
    exit 1
  fi
  snapshot="$(grep -vE '^[[:space:]]*(#|$)' "$PROD_IMAGE_SNAPSHOT" || true)"
else
  if ! snapshot="$(collect_live_snapshot)"; then
    exit 1
  fi
fi

snapshot_count="$(printf '%s\n' "$snapshot" | grep -cE '^(service|job)	' || true)"
if [ "$snapshot_count" -eq 0 ]; then
  echo "ERROR: Cloud Run の稼働イメージを1件も取得できませんでした（snapshot が空です）。" >&2
  echo "       → 実測 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. main の HEAD
# ---------------------------------------------------------------------------
if ! git -C "$DRIFT_REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: git リポジトリではありません: ${DRIFT_REPO_DIR}" >&2
  exit 1
fi
main_sha="$(git -C "$DRIFT_REPO_DIR" rev-parse --verify --quiet "${DRIFT_MAIN_REF}^{commit}" || true)"
if [ -z "$main_sha" ]; then
  echo "ERROR: 比較先 '${DRIFT_MAIN_REF}' を解決できませんでした。" >&2
  echo "       → actions/checkout の fetch-depth: 0 が要ります（既定の 1 では稼働タグの commit も解決できず全件が赤になります）。" >&2
  echo "         HEAD へ暗黙にフォールバックすると、別物と比較して緑になる空振り経路になるため、ここで fail します。" >&2
  exit 1
fi
main_subject="$(git -C "$DRIFT_REPO_DIR" show -s --format=%s "$main_sha")"
main_short="$(git -C "$DRIFT_REPO_DIR" rev-parse --short "$main_sha")"

# ---------------------------------------------------------------------------
# 4. 判定
# ---------------------------------------------------------------------------
# parse_image: イメージ参照を repo 部とタグへ割る。結果は p_repo / p_tag / p_note に入れる
# （bash 3.2 には連想配列が無く、複数値はグローバル経由で返すのが素直）。
p_repo=""
p_tag=""
p_note=""
parse_image() {
  p_repo=""
  p_tag=""
  p_note=""
  case "$1" in
    *@*)
      p_repo="${1%%@*}"
      p_note="digest 固定（${1##*@}）"
      return 0
      ;;
  esac
  case "${1##*/}" in
    *:*)
      p_repo="${1%:*}"
      p_tag="${1##*:}"
      ;;
    *)
      p_repo="$1"
      p_note="タグ指定がありません"
      ;;
  esac
}

# classify_image: 1 つのイメージ参照を分類する。結果は c_status / c_tag / c_detail に入れる。
c_status=""
c_tag=""
c_detail=""
classify_image() {
  local name="$1" ref="$2" deployed_sha oldest_sha oldest_ct age behind_count
  c_status=""
  c_tag=""
  c_detail=""

  case "$ref" in
    us-docker.pkg.dev/cloudrun/container/hello*)
      c_status="placeholder"
      c_detail="Cloud Run 初期 placeholder のまま稼働しています（${ref}）"
      return 0
      ;;
  esac

  parse_image "$ref"
  if [ "$p_repo" != "${IMAGE_BASE}/${name}" ]; then
    c_status="unexpected-image"
    c_detail="期待するイメージは ${IMAGE_BASE}/${name} ですが ${p_repo} が稼働しています"
    return 0
  fi
  if [ -n "$p_note" ]; then
    c_status="unresolvable"
    c_detail="${p_note}: ${ref}"
    return 0
  fi

  c_tag="$p_tag"
  # 短 SHA 形式（16 進 7〜40 桁）か。桁数は固定しない（core.abbrev=auto で伸びるため）。
  tag_bad=0
  case "$p_tag" in
    *[!0-9a-f]*) tag_bad=1 ;;
  esac
  if [ "${#p_tag}" -lt 7 ] || [ "${#p_tag}" -gt 40 ]; then
    tag_bad=1
  fi
  if [ "$tag_bad" -ne 0 ]; then
    c_status="unresolvable"
    c_detail="タグ '${p_tag}' は git の短 SHA 形式ではありません（CI は git rev-parse --short HEAD を打ちます）"
    return 0
  fi

  deployed_sha="$(git -C "$DRIFT_REPO_DIR" rev-parse --verify --quiet "${p_tag}^{commit}" || true)"
  if [ -z "$deployed_sha" ]; then
    c_status="unresolvable"
    c_detail="タグ '${p_tag}' を commit へ解決できません（曖昧・履歴に無い・fetch-depth 不足のいずれか）"
    return 0
  fi

  if [ "$deployed_sha" = "$main_sha" ]; then
    c_status="ok"
    c_detail="main と一致"
    return 0
  fi

  if ! git -C "$DRIFT_REPO_DIR" merge-base --is-ancestor "$deployed_sha" "$main_sha"; then
    c_status="off-main"
    c_detail="稼働 commit ${p_tag} は ${DRIFT_MAIN_REF} の祖先ではありません（巻き戻し・別系統からのデプロイを疑ってください）"
    return 0
  fi

  behind_count="$(git -C "$DRIFT_REPO_DIR" rev-list --count "${deployed_sha}..${main_sha}")"
  # 猶予の起点は「main のトランクへ**着地**した時刻」であって、コミットが書かれた時刻ではない。
  # feature ブランチ上のコミットは committer date が古いまま main へマージされるため、素の
  # rev-list で最古を取ると「3 時間前に書いたコミットを 4 分前にマージした」だけで猶予超過と
  # 誤報する（2026-08-09 の PR #92 マージで実測）。--first-parent で main の幹だけを辿れば、
  # マージコミットの committer date = 着地時刻になる。
  oldest_sha="$(git -C "$DRIFT_REPO_DIR" rev-list --first-parent "${deployed_sha}..${main_sha}" | tail -n 1)"
  if [ -z "$oldest_sha" ]; then
    # 稼働 commit が main の幹に無い（ブランチ上の commit からデプロイされた等）。
    # 幹で測れないので全コミットで測る（保守的に古い側へ倒す）。
    oldest_sha="$(git -C "$DRIFT_REPO_DIR" rev-list "${deployed_sha}..${main_sha}" | tail -n 1)"
  fi
  oldest_ct="$(git -C "$DRIFT_REPO_DIR" show -s --format=%ct "$oldest_sha")"
  age=$((now_epoch - oldest_ct))
  if [ "$age" -lt "$grace_seconds" ]; then
    c_status="in-flight"
    c_detail="未デプロイ ${behind_count} 件・最古 $((age / 60)) 分前（猶予 ${DRIFT_GRACE_MINUTES} 分以内）"
  else
    c_status="behind"
    c_detail="未デプロイ ${behind_count} 件・最古 $((age / 3600)) 時間前（猶予 ${DRIFT_GRACE_MINUTES} 分を超過）"
  fi
  return 0
}

is_green() {
  case "$1" in
    ok|in-flight) return 0 ;;
    *) return 1 ;;
  esac
}

# 深刻度。spec と serving のうち重いほうを署名に採る。
severity_rank() {
  case "$1" in
    ok) echo 0 ;;
    in-flight) echo 1 ;;
    *) echo 2 ;;
  esac
}

snapshot_lookup() {
  # $1=kind $2=name → 一致行（無ければ空）
  printf '%s\n' "$snapshot" | grep -E "^$1	$2	" | sed -n '1p' || true
}

fail=0
checked=0
signature=""

echo "ドリフト検証: 本番 Cloud Run の稼働イメージ × ${DRIFT_MAIN_REF}${injected_note}"
echo "  比較先    : ${main_short} ${main_subject}"
echo "  レジストリ: ${IMAGE_BASE}"
echo "  猶予      : ${DRIFT_GRACE_MINUTES} 分（未デプロイのうち main の幹へ最も古く着地したものの経過時間で判定）"
echo ""

while IFS=$'\t' read -r kind name; do
  [ -n "${kind:-}" ] || continue
  case "$kind" in
    service|job) ;;
    *) continue ;;
  esac
  checked=$((checked + 1))

  row="$(snapshot_lookup "$kind" "$name")"
  if [ -z "$row" ]; then
    # 種別違いで存在していないかを見て、原因を言い分ける。
    if [ "$kind" = "service" ]; then
      other="job"
    else
      other="service"
    fi
    if [ -n "$(snapshot_lookup "$other" "$name")" ]; then
      echo "ERROR: ${kind}/${name} が Cloud Run では ${other} として存在します（kind-mismatch）。" >&2
      echo "       → 正典（infra/envs/prod/main.tf と scripts/push-images.sh）と本番の実体がずれています。" >&2
      signature="${signature}${kind}/${name}=kind-mismatch;"
    else
      echo "ERROR: ${kind}/${name} が Cloud Run に存在しません（missing）。" >&2
      echo "       → tf の適用漏れ、または誤削除を疑ってください。" >&2
      signature="${signature}${kind}/${name}=missing;"
    fi
    fail=1
    continue
  fi

  spec_image="$(printf '%s' "$row" | cut -f3)"
  gen="$(printf '%s' "$row" | cut -f4)"
  obs="$(printf '%s' "$row" | cut -f5)"
  ready_rev="$(printf '%s' "$row" | cut -f6)"
  created_rev="$(printf '%s' "$row" | cut -f7)"
  traffic_rev="$(printf '%s' "$row" | cut -f8)"

  classify_image "$name" "$spec_image"
  spec_status="$c_status"
  spec_tag="$c_tag"
  spec_detail="$c_detail"

  # サービスの収束状態。「spec は新しいのに配信が追いついていない」を捉える（詳細は冒頭コメント）。
  conv_status="-"
  conv_detail=""
  if [ "$kind" = "service" ]; then
    conv_status="converged"
    if [ "$ready_rev" = "NONE" ]; then
      conv_status="no-ready-revision"
      conv_detail="Ready なリビジョンがありません（新リビジョンの起動失敗を疑ってください）"
    elif [ "$created_rev" != "$ready_rev" ]; then
      conv_status="stuck"
      conv_detail="最新リビジョン ${created_rev} が Ready になっておらず、旧 ${ready_rev} が配信され続けています"
    elif [ "$gen" != "$obs" ]; then
      conv_status="not-converged"
      conv_detail="spec の世代 ${gen} に対し反映済みは ${obs} です（更新が配信まで届いていません）"
    elif [ "$traffic_rev" != "$ready_rev" ]; then
      conv_status="traffic-pinned"
      conv_detail="トラフィックの宛先が ${traffic_rev} で、最新の Ready リビジョン ${ready_rev} ではありません"
    fi
  fi

  rep_tag="$spec_tag"
  if [ -z "$rep_tag" ]; then
    rep_tag="?"
  fi

  conv_ok=1
  case "$conv_status" in
    -|converged) ;;
    *) conv_ok=0 ;;
  esac

  worst="$spec_status"
  if [ "$conv_ok" -eq 0 ] && [ "$(severity_rank "$spec_status")" -lt 2 ]; then
    worst="$conv_status"
  fi
  signature="${signature}${kind}/${name}=${worst}@${rep_tag};"

  if is_green "$spec_status" && [ "$conv_ok" -eq 1 ]; then
    if [ "$kind" = "service" ]; then
      echo "OK: ${kind}/${name} → ${spec_status}（${spec_detail}）・${conv_status}（${ready_rev}）"
    else
      echo "OK: ${kind}/${name} → ${spec_status}（${spec_detail}）"
    fi
    continue
  fi

  fail=1
  if ! is_green "$spec_status"; then
    echo "ERROR: ${kind}/${name} のイメージが ${spec_status} です。" >&2
    echo "       → ${spec_detail}" >&2
  fi
  if [ "$conv_ok" -eq 0 ]; then
    echo "ERROR: ${kind}/${name} の配信が ${conv_status} です。" >&2
    echo "       → ${conv_detail}" >&2
    if is_green "$spec_status"; then
      echo "         spec のイメージは ${spec_status} なので、更新は打たれたが実配信まで届いていません。" >&2
    fi
  fi
done <<EOF
$(printf '%s\n' "$targets" | grep -E '^(service|job)	[a-z0-9-]+$')
EOF

# 正典に無いのにクラウドに居るリソース（#33/#35 型: CI が面倒を見ていない本番リソース）。
while IFS=$'\t' read -r kind name rest; do
  [ -n "${kind:-}" ] || continue
  # grep -q は使わない（SIGPIPE × pipefail の偽陽性回避。件数で判定する）。
  same_kind="$(printf '%s\n' "$targets" | grep -cE "^${kind}	${name}\$" || true)"
  if [ "$same_kind" -eq 0 ]; then
    any_kind="$(printf '%s\n' "$targets" | grep -cE "^(service|job)	${name}\$" || true)"
    if [ "$any_kind" -gt 0 ]; then
      continue # kind-mismatch として正典側のループが報告済み
    fi
    echo "ERROR: ${kind}/${name} が Cloud Run に存在しますが、デプロイ対象の正典にありません（unmanaged）。" >&2
    echo "       → CI が更新しないため placeholder や旧イメージのまま放置されます（Issue #33 / #35 と同型）。" >&2
    signature="${signature}${kind}/${name}=unmanaged;"
    fail=1
  fi
done <<EOF
$(printf '%s\n' "$snapshot" | grep -E '^(service|job)	')
EOF

if [ "$checked" -eq 0 ]; then
  echo "ERROR: 1 件も検証できませんでした（対象集合の読み取りが壊れています）。" >&2
  exit 1
fi

echo ""
echo "DRIFT-SIGNATURE: ${signature}"

if [ "$fail" -ne 0 ]; then
  echo "NG: 本番稼働イメージが ${DRIFT_MAIN_REF} と乖離しています（${checked} 件検証・上記参照）。${injected_note}" >&2
  exit 1
fi

case "$signature" in
  *in-flight@*)
    echo "OK: 本番稼働イメージに未反映がありますが、猶予 ${DRIFT_GRACE_MINUTES} 分以内のためデプロイ進行中とみなします（${checked} 件検証・比較先 ${main_short}）。${injected_note}"
    ;;
  *)
    echo "OK: 本番稼働イメージは ${DRIFT_MAIN_REF}（${main_short}）と一致（${checked} 件検証）。${injected_note}"
    ;;
esac
exit 0

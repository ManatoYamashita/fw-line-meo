# 口コミ獲得を施策の前後で読む

アンケートの導線や設問を変えたとき、口コミの獲得がどう動いたかを読むための手順。
Issue #221 の完了条件 4（「変更の前後で口コミ獲得率がどう動いたかを読む手段がある」）と、
Issue #137 の計測基盤の読み方にあたる。要件は `.kiro/specs/review-acquisition/requirements.md` の
Requirement 5.7 / 5.8、数え方の細部は同 `design.md` の ReviewLinkAPI と Monitoring の節にある。

## 何を並べるか

| 段 | 数えるもの | 保持 | 数え方の癖 |
|---|---|---|---|
| 表示 | 事象 `survey_page_viewed` | ログ 30 日・ログベース指標 24 か月 | bot・プリフェッチ・回答済みの再訪も数える。したがって分母としては大きめに出る |
| 送信 | 事象 `survey_response_submitted`。月次の実数は `survey_rating_tallies` の合計 | 同上。DB は無期限 | 集計の加算が失敗した回答はログにだけ残る（両者の差が集計障害の検知になる） |
| 投稿導線の押下 | 事象 `survey_review_link_opened` | 同上 | token を検証できた押下だけを数える。次は数えない（下振れ）: 回答済み画面を開いて 5 分を超えてからの押下（pageToken の失効）、下書き画面で最後の生成から 30 分を超えた押下（sessionToken の失効）、通知の送達に失敗した押下。次は多めに数える（上振れ）: 同じ token の連打（レート制限まで区別しない）、同じ客が下書き画面と 24 時間以内の再訪の回答済み画面の両方で押した場合（別の token なので別件） |
| 口コミの増分 | 自店の `rating_snapshots.review_count` の日次差 | DB **30 日**（日次バッチが削除する） | 自店のすべての口コミを含む（本アンケートを経由しないものも含む）。削除で減る日がある。**30 日を超えた行は消えるので、読める窓に期限がある**（下の 3） |

Google への投稿そのものは客と Google の間で完結し、本システムは観測できない（代理投稿をしない以上、
それが正しい）。製品の側で観測できる最後の段が押下で、その先は口コミの増分として間接的にしか見えない。

**押下の指標は、ログベース指標を作成した時点から数え始める。** 表示と送信の指標は 2026-08-24 から、
押下の指標は Issue #137 の本番適用の日から存在する。それより前の窓は、ログ（30 日）が残っていなければ
比べられない。

## 手順

以下の入力を使う。店舗 ID は実値を与えるが、**記録へ残すときは先頭 8 文字にする**
（steering `tech.md`「spec の実施記録の規律」。店舗 ID は客向けアンケート経路へ到達する唯一の関門である）。

```bash
export PROJECT_ID=gen-fw-line-meo
export STORE_ID='<storeId>'                     # 実値。記録には先頭 8 文字だけを書く
export CHANGE_AT='2026-09-13T04:32:57+09:00'    # 施策が本番へ出た時刻（下の 1 で決める）
export DAYS=10                                  # 前後それぞれの窓の日数（口コミの増分は 14 以下。下の 3）
```

### 1. 施策の時刻を決める

施策が客に届いた時刻は、**survey-web の新しいリビジョンの作成時刻**である。マージの時刻でも
deploy-prod の完了時刻でもない。

```bash
gcloud run revisions list --service=survey-web --region=asia-northeast1 --project="$PROJECT_ID" \
  --limit=5 --format='table(metadata.name,metadata.creationTimestamp)'
```

リビジョンが保持するのはイメージの digest だけなので、そのリビジョンが施策のコミットかどうかは
deploy-prod の出力（`OK: survey-web → …@sha256:…`）と digest を突き合わせて確かめる。

### 2. ファネル（表示・送信・押下）を日次で取る

JST の日ごとに数える。施策の日（`CHANGE_AT` の JST 日付）は前後が混ざるので、どちらの窓にも入れない。

#### 2a. 直近 30 日: ログから実件数を取る

```bash
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"survey-web\" AND jsonPayload.storeId=\"${STORE_ID}\" AND (jsonPayload.event=\"survey_page_viewed\" OR jsonPayload.event=\"survey_response_submitted\" OR jsonPayload.event=\"survey_review_link_opened\")" \
  --project="$PROJECT_ID" --freshness=30d --limit=100000 --format=json \
| python3 -c '
import collections, datetime, json, sys
jst = datetime.timezone(datetime.timedelta(hours=9))
counts = collections.Counter()
for row in json.load(sys.stdin):
    day = datetime.datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")).astimezone(jst).date()
    counts[(day.isoformat(), row["jsonPayload"]["event"])] += 1
for key in sorted(counts):
    print(*key, counts[key])
'
```

Issue #232 のログバケットの分離が本番へ当たった後は、アプリの情報ログは `_Default` ではなく
`fwlm-app-info` バケットへ入る。そのときは `--bucket=fwlm-app-info --location=global --view=_AllLogs` を足す。

#### 2b. 30 日より前を含むとき: ログベース指標から取る

Monitoring API を直接叩く（このバージョンの gcloud には時系列を読むサブコマンドが無い）。
**照会の終端を JST の 0 時に置き、1 日幅（`86400s`）・`ALIGN_DELTA` で揃える。** 揃えずに生の点を
合計すると、点が照会の終端を基準に切り直されて返り、実数にならない。

```bash
TOKEN="$(gcloud auth print-access-token)" python3 - <<'PY'
import datetime, json, os, urllib.error, urllib.parse, urllib.request

jst = datetime.timezone(datetime.timedelta(hours=9))
change = datetime.datetime.fromisoformat(os.environ["CHANGE_AT"]).astimezone(jst)
days = int(os.environ["DAYS"])
# 施策の日の翌日 0 時（JST）から DAYS 日後の 0 時までを終端にすると、前後の窓がすべて収まる
day0 = change.replace(hour=0, minute=0, second=0, microsecond=0)
start = day0 - datetime.timedelta(days=days)
end = day0 + datetime.timedelta(days=days + 1)
now = datetime.datetime.now(jst).replace(hour=0, minute=0, second=0, microsecond=0)
end = min(end, now)  # 未来の区間は照会しない
for metric in ("survey_page_viewed", "survey_response_submitted", "survey_review_link_opened"):
    query = urllib.parse.urlencode({
        # フィルタのラベルは複数形（metric.labels.*）。集約キーの綴り（metric.label.*）と取り違えると 400 になる
        "filter": f'metric.type="logging.googleapis.com/user/{metric}" AND metric.labels.store_id="{os.environ["STORE_ID"]}"',
        "interval.startTime": start.isoformat(),
        "interval.endTime": end.isoformat(),
        "aggregation.alignmentPeriod": "86400s",
        "aggregation.perSeriesAligner": "ALIGN_DELTA",
        "aggregation.crossSeriesReducer": "REDUCE_SUM",
    })
    req = urllib.request.Request(
        f'https://monitoring.googleapis.com/v3/projects/{os.environ["PROJECT_ID"]}/timeSeries?{query}',
        headers={"Authorization": f'Bearer {os.environ["TOKEN"]}'},
    )
    try:
        series = json.load(urllib.request.urlopen(req)).get("timeSeries", [])
    except urllib.error.HTTPError as e:
        # 指標がまだ存在しない（apply 前）ときも 4xx になる。本文に理由が書いてある
        print(metric, "ERROR", e.code, e.read().decode()[:300])
        continue
    for s in series:
        for p in s["points"]:
            # 点の終端はその日の終わり（翌日 0 時）を指す。その日の日付に直す
            day = datetime.datetime.fromisoformat(p["interval"]["endTime"].replace("Z", "+00:00")).astimezone(jst) - datetime.timedelta(days=1)
            value = int(p["value"].get("int64Value", "0"))
            if value:
                print(day.date().isoformat(), metric, value)
PY
```

照会は今日の 0 時（JST）で打ち切る。終わっていない日を数えると、その日だけ小さく出るためである。
点が 1 つも返らない指標は、その期間に事象が 1 件も無かったか、指標がまだ存在しなかったか（404 と
理由が出る）のどちらかである。

**2026-09-13 に本番で 2a と 2b を突き合わせ、日ごとの件数が一致した。** 表示 3 件（2 店舗・3 日）と
送信 2 件を照合した結果で、件数が少ない条件での一致である。上のコマンドそのものも、同じ日に
8/24 を含む窓で流し、ログの実件数と同じ値が出ることを確かめた。件数の多い日が出たら、30 日以内の
窓でもう一度 2a と照合してから 2b を信用すること。

### 3. 口コミの増分を取る

本番 DB への接続は `infra/README.md` の手順に従う（Auth Proxy は 5432 を避け、流す前に店舗名で接続先を確かめる）。

日次バッチは毎朝 6:00（JST）に走り、その日の日付で `captured_on` を記録する。したがって
`captured_on = X` の差分は「前日 6:00 から当日 6:00 まで」の増分である。施策の時刻を含むのは
`(CHANGE_AT + 18 時間)` の JST 日付の区間で（以下 S と書く）、この 1 区間だけを前後どちらの窓にも入れない。

**口コミ件数は 30 日で消える。読める窓に期限がある。** 日次バッチは毎回、30 日を超えた
`rating_snapshots` の行を削除する（`go/internal/repo/summaries.go` の `PurgeOlderThan`）。
Places の規約で place_id 以外のコンテンツの保存は原則禁止・一時キャッシュは最大 30 日とされるため、
30 日ローリングにしている（`.kiro/specs/competitive-daily-summary/research.md` の Decision）。

前の窓の最初の差分には `S − DAYS − 1` 日の行が、後の窓の最後の差分には `S + DAYS` 日の行が要る。
ある日 R の 6:00 の日次バッチの後に残っているのは `R − 29` 日から R 日までなので、**前後両方の窓が
揃うのは、R が `S + DAYS` 以上 `S + 28 − DAYS` 以下の日だけ**である（`29 − 2 × DAYS` 日間）。
`DAYS=10` なら 9 日間、`DAYS=14` なら 1 日しかなく、15 以上では一度も揃わない。この期間を逃すと、
前の窓の差分が古い側から 1 日ずつ消え、下の SQL の `区間数` と `増分` が静かに減る。

期間を逃しそうなら、前の窓だけを施策の直後に読んでおく。ただし、読んだ値を 30 日を超えて残して
よいかは、Places の規約（一次情報）で確かめてから決めること。30 日ローリングにしている理由と
同じ規定に触れるおそれがある。

```bash
psql "<接続文字列>" -X -v store="$STORE_ID" -v change_at="$CHANGE_AT" -v days="$DAYS" <<'SQL'
WITH d AS (
  SELECT captured_on,
         review_count - lag(review_count) OVER (ORDER BY captured_on) AS delta
  FROM rating_snapshots
  WHERE store_id = :'store' AND subject_kind = 'self'
), k AS (
  SELECT ((:'change_at')::timestamptz AT TIME ZONE 'Asia/Tokyo' + interval '18 hours')::date AS straddle
)
SELECT CASE WHEN d.captured_on < k.straddle THEN '前' ELSE '後' END AS 窓,
       count(d.delta) AS 区間数,
       sum(d.delta)   AS 増分,
       -- 差分が取れた行だけで数える（前日の行が消えた日は delta が NULL になる）
       min(d.captured_on) FILTER (WHERE d.delta IS NOT NULL) AS 最初,
       max(d.captured_on) FILTER (WHERE d.delta IS NOT NULL) AS 最後
FROM d, k
WHERE d.captured_on <> k.straddle
  AND d.captured_on >= k.straddle - :days
  AND d.captured_on <= k.straddle + :days
GROUP BY 1
ORDER BY 1 DESC;
SQL
```

`区間数` が `DAYS` に満たない窓の原因は 3 つある。窓がまだ終わっていない、日次バッチが走らなかった日がある、
保持期間を過ぎて行が削除された（上の期限）。2 つ目なら、欠けた日の増分は隣の日の差分へ寄る
（合計は変わらない）。3 つ目なら、消えた日の増分はどこにも残らない（合計が減る）。前の窓の `最初` が
`S − DAYS` より後の日付なら 3 つ目である。

### 4. 送信の月次の実数を取る

ログと指標は送信を日次で数えるが、集計の加算が失敗した回答も含む。DB の月次集計は加算が成功した
回答だけを数える。両者の差が集計障害の量である。

```bash
psql "<接続文字列>" -X -v store="$STORE_ID" <<'SQL'
SELECT period_month, sum(count) AS 送信
FROM survey_rating_tallies
WHERE store_id = :'store'
GROUP BY period_month
ORDER BY period_month;
SQL
```

### 5. 並べて読む

窓ごとに、表示・送信・押下の合計と、口コミの増分を 1 表に並べる。比率を出すなら「送信 / 表示」と
「押下 / 送信」の 2 つである。

読み方の癖:

- **件数が少ないうちは比率を出さない。** 1 件の差で比率が大きく動く。件数そのものを並べる
- 「送信 / 表示」は下限として読む（表示に bot・プリフェッチ・再訪が混ざる）
- 「押下 / 送信」は両方向に振れる。下振れは token の失効（回答済み画面の 5 分・下書き画面の 30 分）と送達失敗、
  上振れは同じ token の連打と、同じ客の下書き画面と再訪時の二重の押下である。**施策が回答から投稿までの
  所要時間や再訪の割合を変えると、客の行動と無関係に押下率が動いて見える**。そうした施策では押下率を単独で読まない
- **口コミの増分は本アンケートを経由しない口コミを含む。** 押下の件数が増分より十分小さい店舗では、
  施策の効果は増分に埋もれて読めない。押下は「増分のうち本アンケートが寄与しえた上限」として並べる
- 増分の日次差は負になりうる（削除）。窓の合計で読む
- 同じ窓に他の変化（QR の設置場所・店内掲示・季節要因）が重なっていないかを、結果と一緒に記録する

## 関連

- Issue #137（計測基盤）／ Issue #221（完了条件 4）
- 記録の正典: `log-field-canon.md`（`survey_page_viewed` / `survey_response_submitted` / `survey_review_link_opened`）
- 指標の宣言: `infra/modules/guardrails/main.tf` の `survey_funnel`

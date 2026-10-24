# 構造化アンケート：1 店舗パイロット公開の運用手順（#441 PR7）

## 目的と境界

PR #443 で本番へデプロイされる structured survey の実装を、**運営が指定した検証用の 1 店舗だけ**有効化する。客向け UI は main の既存実装（「気になったところ」は初期折りたたみ）をそのまま使用する。PR #471（両側を常に開く）は本手順の前提にしない。

- この文書・PRは**公開を実行しない**。実行はプロジェクトの Cloud SQL 運用権限を持つ担当者が、対象店舗と影響を確認して行う。
- 全店舗の一括有効化はしない。店舗側 LIFF に ON/OFF 権限を足さない。新しい Cloud Run 環境変数や DB migration は要らない。
- 本番の実店舗を対象にする場合は、クライアントの許可と Issue #460 の表示方針・Google 口コミポリシーの検討を先に記録する。先行確認は運営が管理する検証用店舗・運営関係者だけで行い、Google に実レビューを投稿しない。
- テスト回答は本番の匿名集計を増やす。**フラグを OFF にしてもその集計は戻らない**。実行する送信回数を決め、実測を記録する。
- 店舗 ID・料理名・オーナーの氏名・回答本文・シークレットを Issue/PR に書かない。

## 事前チェック（1 つでも未確認なら有効化しない）

1. **対象**: 検証用の 1 店舗を運用者が指定し、店舗 UUID が正しいことを認証済み管理画面/Cloud SQL で確認する。店舗の place_status が confirmed、suspended_at が NULL。対象が実在クライアントの場合は許可も確認。
2. **アプリ**: main に #443 および #470 が統合されており、対象の survey-web と store-detail が期待するバージョンで稼働。関連 CI の E2E が成功。#471 は未マージのため折りたたみを維持。
3. **スキーマ/権限**: infra/README.md §3 の SQL で migration 0015/0016・7 表・必要な GRANT を読取確認。本番データの構造だけを確認し、無断で migration/grants を再実行しない。
4. **互換モード**: survey-web の STRUCTURED_SCHEMA_COMPAT_FALLBACK が未設定、または 1 ではないことを Cloud Run 側で確認。ON のままパイロットへ進まない。
5. **事前の画面**: 対象店舗の店舗設定（LIFF）で、料理・ドリンク・カテゴリの設定を保存済み。公開前は QR の顧客画面が legacy であることを確認する。テスト用の具体的な商品名には「絶品餃子」のような現在拒否される語を使わない（#480）。
6. **接続先**: infra/README.md §3 に従い Cloud SQL Auth Proxy（ローカル 15432）へ接続。以下が **on** でなければ直ちに停止する。5432 や任意の開発 DB へ接続しない。

~~~sql
SELECT setting FROM pg_settings WHERE name = 'cloudsql.iam_authentication';
~~~

以下の SQL は同じ psql 接続で読む。**一部の行を抜き出して実行しない**。PGHOST/PGPORT/PGUSER/PGDATABASE/認証は infra/README.md §3 の手順で設定する。

~~~
# 店舗 ID の UUID は運用担当者が手元でセットする。値を Issue/PR やコマンド出力へ貼らない。
read -r -p '検証用店舗 UUID: ' PILOT_STORE_ID
export PILOT_STORE_ID
~~~

事前読み取り（店舗名や氏名は取得しない）：

~~~sh
psql -X -v ON_ERROR_STOP=1 -v store_id="$PILOT_STORE_ID" <<'SQL'
SELECT current_setting('cloudsql.iam_authentication', true) = 'on' AS cloud_sql;
SELECT s.place_status, s.suspended_at IS NULL AS not_suspended,
       COALESCE(c.structured_enabled, false) AS structured_enabled,
       c.revision,
       (SELECT count(*) FROM store_survey_targets t WHERE t.store_id = s.id AND t.active) AS active_targets
FROM stores s
LEFT JOIN store_survey_configs c ON c.store_id = s.id
WHERE s.id = :'store_id'::uuid;
SELECT count(*) AS enabled_store_count FROM store_survey_configs WHERE structured_enabled;
SQL
~~~

対象行が **1 件だけ**返ること、confirmed・not_suspended=true・structured_enabled=false、対象が承認済みの検証用店舗であることを確認する。対象 0 件・already enabled・接続先不明なら停止する。

## 有効化（運用者による手動実行だけ）

**上の前提が満たされた時だけ実行する。** DB セッション中の店舗 ID は PostgreSQL の transaction-local 設定に渡し、変更する行を UUID で 1 店舗へ限定する。stores 行のロックと config の upsert により、同時の店舗設定変更と版数を食い違わせない。

~~~sh
psql -X -v ON_ERROR_STOP=1 -v store_id="$PILOT_STORE_ID" <<'SQL'
BEGIN;
SELECT set_config('fwlm.pilot_store_id', :'store_id', true);
DO $$
DECLARE
  target uuid := current_setting('fwlm.pilot_store_id')::uuid;
  affected integer;
BEGIN
  IF current_setting('cloudsql.iam_authentication', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'not connected to Cloud SQL';
  END IF;
  PERFORM 1 FROM stores
    WHERE id = target AND place_status = 'confirmed' AND suspended_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pilot store missing, unconfirmed, or suspended';
  END IF;
  INSERT INTO store_survey_configs (store_id, structured_enabled, revision)
    VALUES (target, true, 1)
    ON CONFLICT (store_id) DO UPDATE
      SET structured_enabled = true,
          revision = store_survey_configs.revision + 1,
          updated_at = now()
      WHERE store_survey_configs.structured_enabled = false;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'pilot not changed (already enabled?)';
  END IF;
END $$;
SELECT count(*) AS enabled_target_count
  FROM store_survey_configs
  WHERE store_id = :'store_id'::uuid AND structured_enabled;
COMMIT;
SQL
~~~

上の確認値が **1** 以外なら成功扱いしない。エラー時は psql の終了コードと DB のトランザクション失敗を確認し、再実行前に事前読み取りからやり直す。勝手に 2 店舗目を追加しない。

## 有効化後のスモーク（Google への実投稿はしない）

1. 対象店舗の QR（survey-web）を開き、新しいカテゴリ・Target・facet が表示されることを確認する。他の店舗の QR は legacy のまま。
2. 「良かったところ」は初期表示。「気になったところ」は**最初は折りたたみ**で、開くと回答できる。★1〜★5で出し分けがなく、Google の投稿導線は誰にも隠れないことを確認する。
3. 運営の検証用ブラウザで、承認した回数だけテスト回答。口コミ下書きの生成・再生成・コピー・Google 投稿画面の開き方を確認する（**実際の投稿はしない**）。未入力の具体的事実が文章に追加されないことを確認する。
4. 店舗設定を変更した後の QR 再表示と stale revision の案内、送信エラーと再試行、コピー失敗時の案内を確認する。
5. 個別回答を DB へ保存しないことを維持し、匿名集計の増分、画面の 5xx、生成失敗の件数だけを把握する。ログへ本文や個人情報を出さない。
6. GitHub Issue #441 に、実施日・担当者・コードのコミット・対象「運営検証用1店舗」（UUIDや店名は不要）・送信回数・成功/失敗・未確認事項・ロールバック要否を記録する。

## 問題があった場合の即時ロールバック（1 店舗だけ）

この操作は**客に表示する方式だけを legacy に戻す**。既存の設定や匿名集計を削除しない。実行前に、対象が当初指定した店舗であることを再確認する。

~~~sh
psql -X -v ON_ERROR_STOP=1 -v store_id="$PILOT_STORE_ID" <<'SQL'
BEGIN;
SELECT set_config('fwlm.pilot_store_id', :'store_id', true);
DO $$
DECLARE
  target uuid := current_setting('fwlm.pilot_store_id')::uuid;
  affected integer;
BEGIN
  IF current_setting('cloudsql.iam_authentication', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'not connected to Cloud SQL';
  END IF;
  UPDATE store_survey_configs
     SET structured_enabled = false, revision = revision + 1, updated_at = now()
   WHERE store_id = target AND structured_enabled = true;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'pilot not disabled (not enabled or wrong store?)';
  END IF;
END $$;
SELECT count(*) AS disabled_target_count
  FROM store_survey_configs
  WHERE store_id = :'store_id'::uuid AND NOT structured_enabled;
COMMIT;
SQL
~~~

QR を再読み込みして legacy に戻ったことを確認する。すでに開いている structured の回答画面は旧い token のまま送信できない可能性があるので、検証者はページを再読み込みする。UI の不具合を隠すために本番ログや個別集計を消さない。

## 完了判断

- [ ] 運用者が対象の 1 店舗と権限・利用許可を確認した
- [ ] 0015/0016/grants・Cloud SQL 接続・fallback=OFF・対象環境のデプロイを確認した
- [ ] 本番 DB の変更結果が 1 店舗だけである
- [ ] 主/気になる点（初期折りたたみ）・新 Target・Gemini 生成・コピー/Google 導線・stale 再読込を実画面で確認した
- [ ] 客の実レビューを投稿せず、匿名集計への検証入力回数を記録した
- [ ] 問題があれば上記 1 店舗だけ OFF に戻した
- [ ] 進捗・未確認条件を #441 に記録し、担当者が拡大の可否を判断した

関連: #441 #435 #443 #460 #471 #480。接続・権限の正典は infra/README.md §3。

# Gap Analysis: owner-line-unlink

- 実施日: 2026-10-24
- 対象: `requirements.md`（Requirement 1〜9・未承認）
- 基準: `origin/main` = `1519b5f`

## 1. 要約

- **DB の権限は既にある。** `dashboard` SA は `owners`・`onboarding_sessions`・`stores` に DML を持ち（`infra/sql/grants.sql:77`）、`audit_logs` へ INSERT できる。書込境界（`db/write-boundary.md`）は言語単位（TS / Go）で、`owners` は「TS リアルタイム応答層」の所有である。dashboard-api（TS）が書いても言語の境界は越えない。改訂が要るのは用途の記述だけである。
- **欠けているのは 3 つ。** (1) 解除済みを表す状態（`owners.line_user_id` は `NOT NULL UNIQUE`）、(2) dashboard-api から LINE を呼ぶ手段（資格情報も LINE クライアントも無い）、(3) オンボーディングの確定で、解除済みオーナーの店舗を引き継ぐ分岐。
- **共有の `confirmStore` に引継ぎを入れてはならない。** dashboard-api の店舗登録も同じ `StoreIdentificationService.confirmStore` を使う（`ts/apps/dashboard-api/src/composition.ts:76`）。ここに入れると、管理画面の登録が付け替えになる。管理画面での付け替えは Out of scope である。
- **旧 LINE ID を使う箇所は 5 つ。** 配信の 2 クエリ、LIFF の認可、完了後メニューの一括張り直し、GBP の通知。表現の選び方によって、構造的に効く箇所と述語を足す箇所が分かれる（§3.1）。
- **GBP の OAuth トークンは店舗単位である**（`oauth_tokens.store_id`）。店舗を引き継ぐと、前の担当者の Google 連携も一緒に移る。第2フェーズで既定は OFF だが、コードは main にある。設計で扱いを決める必要がある（Research Needed）。

## 2. 現状の資産

### 2.1 line-webhook（オンボーディング）

| 資産 | 場所 | 本機能との関係 |
|---|---|---|
| 入口の振り分け | `onboarding/conversation.ts` の `handleEvent` | `findOwnerByLineUserId` → `isStoreIdentified` の 2 段だけで決まる。旧 LINE ID でオーナーが引けなくなれば、未登録と同じ経路（`handleFollow` → 挨拶＋招待コード）へ落ちる＝Req 4.1 は構造的に満たせる |
| 招待コードの受理 | `handleValidInviteCode` | `createOwner` で新しいオーナーを作る。**旧オーナーが同じ `line_user_id` を持ったままだと UNIQUE 違反で失敗する**。解除時に元の値を空ける必要がある |
| 会話のセッション | `onboarding_sessions`（PK = `line_user_id`・`owner_id` は CASCADE） | 旧オーナーを指す行が残ると、`ck_session_owner_stage` の段階（例: `completed`）が持ち越される。Req 4.2 のため、解除時に行を消すか初期化する |
| 確定 | `handleConfirm` → `identification.confirmStore` | `place_already_registered` で終わる。自分自身の重複（連打）だけは成功扱いにする既存の分岐がある（`store-identification.ts`）。引継ぎはこの隣に入れる候補 |
| 完了後メニュー | `owner/completed-menu.ts` の `linkCompletedMenu` | 張るだけで、外す関数は無い。成否を事象と監査記録へ残す規律（Issue #228）は流用できる |
| LINE クライアント | `line/client.ts` | `reply` / `push` / `getProfile` / `linkRichMenu` / `startLoading`。**unlink も get も無い** |
| unfollow | `webhook/dispatch.ts` | 黙って無視する。Req 8.2 は現状のままで満たす |
| 一括張り直し | `scripts/relink-completed-menu.ts:251` | `onboarding_status = 'store_identified'` の全オーナーへ張る。解除済みオーナーは引継ぎ後も `store_identified` のまま残るので、**除外の述語が要る**（Req 3.5） |

### 2.2 dashboard-api / dashboard-web

| 資産 | 場所 | 本機能との関係 |
|---|---|---|
| 停止・再開のハンドラ | `dashboard-api/src/store-suspension.ts` | そのまま型紙になる。認証 → UUID の事前ガード → `resolveAgencyScope` → 範囲つきの 1 文の更新（範囲外と不存在を同じ 404 にする）→ 変化したときだけ監査記録。Req 1.1〜1.5・7.1・7.3 と対応する |
| オーナー一覧 | `owners-list.ts`・`listOwnersByAgency` | 店舗登録でオーナーを選ぶためだけにある。運営は代理店の指定が必須（範囲 `all` は 400）。連携状態は返さない |
| 店舗一覧 | `stores-list.ts` | 各店舗にオーナー ID と表示名がある。オーナー単位の画面は無い |
| 画面 | `dashboard-web/src/app/stores/store-suspension-control.tsx` | 確認ダイアログつきの操作の型紙（Req 1.4） |
| 設定 | `dashboard-api/src/config.ts` | `SURVEY_BASE_URL`・`DASHBOARD_WEB_ORIGIN`・`PLACES_API_KEY` だけ。LINE の env は無い |
| 監査の記録 | `audit.ts` の `recordAudit` | 失敗は警告を残して握る（#250 の決定）。そのまま使える |

### 2.3 読み手（旧 LINE ID の消費箇所）

| 箇所 | クエリ | 解除後の振る舞い |
|---|---|---|
| `delivery-job/src/targets.ts:127` `queryDeliveryTargets` | `JOIN owners` で `o.line_user_id` を宛先に使う | 述語が無いと、解除済みオーナーの店舗も配信対象に残る |
| `delivery-job/src/targets.ts:181` `queryOwnersDueWithoutSummary` | 同上（集計が無い日の見送り記録） | 同上。Req 5.3（記録も残さない）のため、こちらにも述語が要る |
| `store-detail/lib/liff-auth.ts:166` | `WHERE line_user_id = $1` | 旧 LINE ID でオーナーが引けなくなれば `OWNER_NOT_FOUND`＝Req 4.3 は構造的に満たせる |
| `line-webhook/src/gbp/callback.ts:331` | `findOwnerById` → `push(owner.line_user_id)` | 述語が要る（Req 4.5）。既定は OFF |
| `line-webhook/scripts/relink-completed-menu.ts:251` | 上記 | 述語が要る（Req 3.5） |
| Go の日次バッチ | `owners` を読まない | 変更不要。Req 5.1（取得を続ける）は現状のままで満たす |

### 2.4 DB と検査

- `owners`: `line_user_id text NOT NULL UNIQUE`、`onboarding_status`、`delivery_hour`（0001・0004）。
- `stores.owner_id` は `ON DELETE RESTRICT`。`stores` の列単位の GRANT（`grants.sql:91`）は `owner_id` を line_webhook に許している。引継ぎ（`stores.owner_id` の書き換え）に新しい権限は要らない。
- `ck_audit_logs_action` は最新が 0016。新しい action を足すには、0009/0012 と同じ「作り直し」の migration を書く。次の番号は 0017（open PR との番号衝突を提出直前に確かめる。memory `new-guard-breaks-main-after-merge`）。
- 不在検査 `db/test/check_no_optional_capabilities.sh`: (A1) は `owners`・`stores` の列名の denylist（`delivery_enabled`・`opted_out`・`unsubscribed` など）。(B2) は識別子の禁止パターン（`optOut|opt_out|unsubscribe|disableDelivery|…`）。`unlink` は含まれない。列名を `line_unlinked_at` などにすれば衝突しない。
- 前例: store-suspension は `stores.suspended_at` を **dashboard SA にしか書けないように** 列単位の GRANT で絞った（`grants.sql:81-96`・`check_store_suspension_privileges.sh`）。オーナーの面（line_webhook・survey）にこの列を書かせないことで、オプトアウトの不在を DB で保証している。Req 8.1・8.3 に同じ手が使える。

### 2.5 LINE の資格情報

- stateless token の発行（`POST /oauth2/v3/token`・`client_credentials`）は **line-webhook と delivery-job に別々の実装**がある（`line/client.ts:64`・`delivery-job/src/line.ts:34`）。共有パッケージは無い。
- シークレットは `line-channel-secret` の 1 つ（Webhook の署名検証とトークンの発行を兼ねる）。`LINE_CHANNEL_ID` は env の平文（`infra/envs/prod/main.tf:85`・`modules/delivery-job/main.tf:66`）。
- dashboard-api が LINE を呼ぶなら、新しいシークレットは要らない。要るのは消費側の配線（secret のマウント、SA への `secretAccessor`、`LINE_CHANNEL_ID`）である。`check-secret-declaration-coverage.sh` は消費側の配線を照合するので、宣言の更新も要る（memory `secret-addition-declaration-contract`）。
- LINE API（`.claude/skills/messaging-api/references/rich-menu.md`）: 個別リンクの解除は `DELETE /v2/bot/user/{userId}/richmenu`、確認は `GET /v2/bot/user/{userId}/richmenu`。**リンクはブロック中のユーザーに対して 200 を返しつつ黙って失敗する**と明記されている。解除の側の同じ挙動は書かれていない。

## 3. 要件と資産の対応

| Req | 必要なもの | 状態 |
|---|---|---|
| 1.1–1.3, 1.5 | 範囲つきの解除（範囲外と不存在を同じ応答に） | **Missing**（型紙は `store-suspension.ts`） |
| 1.4 | 確認つきの操作 UI | **Missing**（型紙は `store-suspension-control.tsx`） |
| 1.6 | 物理削除しない | Constraint（RESTRICT が保証） |
| 1.7 | 失敗時に解除前の状態のまま | 解除の DB 書込を 1 トランザクションにすれば満たせる |
| 2.1–2.4 | オーナー単位の連携状態の表示と操作 | **Missing**。オーナー単位の画面が無い。店舗一覧の行に置くか、オーナー一覧を新設するか（§4） |
| 2.5 | 店舗登録のオーナー選択で区別 | `listOwnersByAgency` に状態を足す |
| 3.1 | 解除時にメニューを外す | **Missing**（LINE クライアントに unlink が無い・dashboard-api に資格情報が無い） |
| 3.2–3.4 | 外せなかったときの表示と外し直し | **Missing**。「外せたことが確かめられていない」を保持する場所が要る（列か監査記録か）。**Unknown**: ブロック中のユーザーへの unlink の挙動 |
| 3.5 | 一括張り直しから除外 | 述語を足す |
| 4.1, 4.3, 4.4 | 旧 LINE ID でオーナーが引けない | 表現の選び方しだいで構造的に満たせる（§3.1） |
| 4.2 | 会話の進み具合を持ち越さない | 解除時にセッションを消す |
| 4.5 | 解除済みへ送らない | 配信の 2 クエリと GBP の通知に述語を足す |
| 5.1 | 取得を続ける | 現状のまま（Go は `owners` を読まない） |
| 5.2–5.4 | 配信しない・記録もしない | 配信の 2 クエリに述語を足す（停止の `suspended_at IS NULL` と同じ位置） |
| 5.5 | 停止・アンケート・QR を変えない | 現状のまま（それぞれ `owners` の連携状態を見ない） |
| 6.1, 6.6 | 同じ代理店からの確定で全店舗を引き継ぐ（競合は 1 つだけ） | **Missing**。行ロックか条件つき UPDATE の件数で 1 つに絞る |
| 6.2 | 通常の完了と同じ遷移 | `handleConfirm` の既存の後処理を流用できる |
| 6.3 | 停止・QR・データを変えない | `stores.owner_id` だけを書き換えれば満たせる。**Constraint**: GBP の連携（`oauth_tokens`・`gbp_locations`）が店舗に付いて移る |
| 6.4, 6.5 | 別の代理店・連携中は拒否 | 既存の `place_already_registered` に寄せる |
| 6.7, 6.8 | 引継ぎ後の配信と詳細画面 | 現状のまま（`stores.owner_id` で解決する） |
| 6.9 | 管理画面で新しいオーナーの店舗として表示 | 現状のまま（店舗一覧は `owner_id` を JOIN する） |
| 6.10 | `line-onboarding` Req 4.4 の改訂 | 文書の変更 |
| 7.1–7.4 | 新しい監査の action（解除・引継ぎ） | `ck_audit_logs_action` を作り直す migration |
| 8.1, 8.3, 8.4 | オーナー自身の解除の不在 | 不在検査の拡張と、列単位の GRANT（前例どおり） |
| 8.2 | ブロックで状態を変えない | 現状のまま |
| 9.1–9.3 | 本番での確認 | 手順の作成（`docs/testing/e2e.md`・memory `prod-e2e-leaves-permanent-tenant`） |

### 3.1 解除済みの表し方（設計判断の材料）

| 案 | 内容 | 旧 LINE ID の読み手 | 不在の保証 | 注意 |
|---|---|---|---|---|
| R1: 列を足し、`line_user_id` を NULL にする | `line_unlinked_at timestamptz` を足し、`line_user_id` を nullable にする | 引けなくなる＝LIFF 認可・入口は構造的に効く。`JOIN owners` の配信は NULL 宛先になるので述語が必須 | 列単位の GRANT で `line_unlinked_at` と `line_user_id` の UPDATE を dashboard だけにできる | `NOT NULL` を外すと「連携中なのに NULL」の行を作れる。CHECK（`(line_unlinked_at IS NULL) = (line_user_id IS NOT NULL)`）で両輪にする。`OwnerRow.line_user_id: string` の型が変わり、消費箇所が型検査で全部見つかる（利点） |
| R2: 列を足し、`line_user_id` は残す | `line_unlinked_at` だけ足す | 全読み手に述語が要る。UNIQUE が残るので同じ LINE アカウントで再オンボーディングできない | 同上 | **Req 4.1（同じアカウントのやり直し）を満たせない**。UNIQUE を部分一意（`WHERE line_unlinked_at IS NULL`）にすれば満たせるが、`findOwnerByLineUserId` が複数行を返しうる |
| R3: 値の付け替え（2026-10-24 の手作業と同じ） | `line_user_id = 'detached-…:' \|\| line_user_id` | LIFF・入口は構造的に効く。配信は不正な宛先へ push して失敗を記録する（Req 5.3 違反）ので述語が要る | 書式の判定を検査が知る必要がある | 意味がデータの書式に埋まる。Issue #487 でも短所として挙がっている |

## 4. 実装方針の選択肢

### 方式 A: dashboard-api が全部やる（既存を拡張）

- dashboard-api に解除のルートを足す。1 トランザクションで `owners` を解除済みにし、`onboarding_sessions` を消す。コミット後に LINE の unlink を呼び、成否を返す。
- 引継ぎは line-webhook の確定の分岐に足す。共有の `confirmStore` には入れず、オンボーディング専用の確定にする。
- 必要なもの: dashboard-api への LINE 資格情報の配線（secret のマウント・IAM・`LINE_CHANNEL_ID`）と、LINE クライアントの 3 つ目の実装（または共有パッケージへの切り出し）。
- ✅ 同期で結果が分かる（Req 3.2 の表示がそのまま書ける）。停止（#252）と同じ形で、読み手が迷わない。
- ❌ dashboard-api の権限が LINE まで広がる。トークン発行の実装が 3 つ目になる（重複の増加）。

### 方式 B: LINE の操作を line-webhook に任せる（新規の内部経路）

- dashboard-api は DB だけを書き、「メニュー未解除」の状態を残す。メニューを外すのは line-webhook である。
- 外す契機の候補: (b1) dashboard-api から line-webhook の認証つき内部エンドポイントを呼ぶ、(b2) 解除済みの LINE アカウントから次にイベントが来たとき（遅延）、(b3) 定期ジョブ。
- ✅ LINE の資格情報が line-webhook と delivery-job から外へ広がらない。
- ❌ (b1) は line-webhook に、署名検証とは別の認証面（サービス間の IAM 認証）を新設することになる。(b2) は話しかけてこないアカウントのメニューが外れない。Req 3.1・9.2 の「解除と同時に」を満たさない。(b3) は Cloud Run ジョブの追加（デプロイ正典 7 件の更新・監視の宣言）になる。

### 方式 C: 混成（推奨候補）

- DB の書込と RBAC は dashboard-api（方式 A）。
- LINE の unlink と get は、トークンの発行と合わせて**共有パッケージへ切り出し**、dashboard-api と line-webhook の両方が使う。delivery-job の重複は今回は触らない（範囲を広げない）。
- 引継ぎは line-webhook の確定の分岐（オンボーディング専用）に置く。
- 「メニュー未解除」の状態を持ち、外し直しの操作（Req 3.3・3.4）を同じルートの再実行で表す。
- ✅ 同期の表示を保ったまま、トークン実装の 3 重化を避けられる。
- ❌ パッケージの切り出しで line-webhook の差分が増える。PR #472（招待コードの正規化）が `conversation.ts` を触っているので、統合の順を考える。

## 5. 規模とリスク

- **規模: L（1〜2 週間）**。migration（列・CHECK・GRANT・監査の action）、dashboard-api のルート、dashboard-web の画面、line-webhook の引継ぎ、配信の述語、LINE の資格情報の配線、不在検査の拡張、cross-runtime の固定、本番での確認。どれも既存の型紙があるが、触る層が 5 つある。
- **リスク: Medium**。型紙（store-suspension）はあるが、(1) 本番の IAM とシークレットの配線、(2) 列単位の GRANT の本番への再適用（前例で手順が要った）、(3) ブロック中のユーザーへの unlink の挙動が未確認、の 3 点に不確実性がある。

## 6. 設計フェーズへの申し送り

### 6.1 決めること
1. 解除済みの表し方（§3.1。R1 が最も多くの要件を構造で満たす）
2. LINE を呼ぶ層（方式 A / B / C）と、共有パッケージを切り出すかどうか
3. オーナー単位の画面を新設するか、店舗一覧の行に置くか。運営が「代理店を指定しないと一覧が出ない」既存の制約（`owners-list.ts`）をどうするか
4. 「メニュー未解除」の保持場所（列 / 監査記録から導出）
5. 引継ぎの排他（`SELECT … FOR UPDATE` / 条件つき UPDATE の件数）と、空になった解除済みオーナーの行の扱い
6. 引き継ぐ店舗に付いた GBP の連携（`oauth_tokens`・`gbp_locations`・`gbp_sessions`）を外すか残すか
7. `owners` の列単位の GRANT（line_webhook・survey から `line_user_id` の UPDATE と解除の列を剥がすか）

### 6.2 Research Needed
- **ブロック中のユーザーへの `DELETE /v2/bot/user/{userId}/richmenu` と `GET` の挙動**。リンクは「200 を返して黙って失敗する」とされる。解除の側も同じなら、Req 3.3 の「外せたことの確認」は GET の 404 で取れない可能性がある。`@line/bot-sdk` の生成型と、本番の検証用アカウントで確かめる（memory `line-api-contract-from-sdk-types`）。
- **ブロック中に個別リンクが残るか**。ブロック→解除で個別リンクが戻るなら、解除時に外せなかった場合でも、次の follow で外し直す手（line-webhook 側）が要るかどうかが決まる。
- **GBP の連携が店舗と一緒に移ることの扱い**。Google 側の権限は前の担当者の Google アカウントに紐づく。第2フェーズの有効化（関門 A）より前に決めればよいのか、本 spec で外すのか。
- **dashboard-api の SA に `line-channel-secret` の `secretAccessor` を付けることの影響**。この secret は Webhook の署名検証鍵でもある。dashboard-api が読めると、Webhook を偽造できる主体が増える。トークンの発行に要る鍵と署名の鍵が同じであることを前提に、許容するか判断する。

### 6.3 統合上の注意
- open PR #472 が `ts/apps/line-webhook/src/onboarding/conversation.ts` を触っている。
- migration 番号 0017 は、提出直前に open PR と照合する。
- 本番適用は `to_regclass` / 列の存在で確かめてから操作する（Req 9.1・memory `prod-gcp-access-recipes`）。

---

# Design Discovery & Decisions（/kiro-spec-design・2026-10-24）

## Summary
- **Feature**: `owner-line-unlink`
- **Discovery Scope**: Extension（既存の 5 層へ統合。外部 API は既存の LINE Messaging API の未使用エンドポイントのみ）。ただし LINE の資格情報を新しい主体へ配るので、セキュリティは full discovery の深さで扱った
- **Key Findings**:
  - `owners.line_user_id` を NULL にすると、旧 LINE ID を引く読み手（入口の振り分け・LIFF の認可・振り分け口）は**述語を足さずに**解除済みを扱える。述語が要るのは `JOIN owners` で宛先を取る配信の 2 クエリ、GBP の通知、一括張り直しの 3 箇所だけで、`OwnerRow.line_user_id` を `string | null` にすれば、型検査が漏れを示す
  - NULL にすると、メニューを外し直すための元の ID が失われる。Req 3.3/3.4 のため、**外し終えるまでの間だけ**元の ID を別の列に置く。外し終えたら消すので、退職した担当者の LINE ID を無期限には持たない
  - store-suspension は、列単位の GRANT でオーナーの面（line_webhook・survey）から `suspended_at` を書けなくし、オプトアウトの不在を DB で保証した。同じ手で `owners` の `line_user_id` の UPDATE と解除の列を剥がせば、Req 8.1・8.3 を DB で保証できる。line-webhook は `line_user_id` を UPDATE しない（INSERT だけ）ので、剥がしても既存の動作は変わらない

## Research Log

### LINE の個別リッチメニューの解除と確認
- **Context**: Req 3.1–3.4・9.2
- **Sources Consulted**: `.claude/skills/messaging-api/references/rich-menu.md`（Per-user Rich Menu の表と Link conditions）、`ts/apps/line-webhook/src/line/client.ts`（既存のリンク実装）
- **Findings**:
  - 解除は `DELETE /v2/bot/user/{userId}/richmenu`、確認は `GET /v2/bot/user/{userId}/richmenu`（`richMenuId` を返す）
  - リンクは、ブロック中・未友だち・削除済みのユーザーに対して 200 を返しつつ黙って失敗する。**解除の側の同じ挙動は文書に無い**
  - 個別リンクが無いユーザーへの DELETE の応答（2xx か 404 か）も文書に無い
- **Implications**: 外せたかどうかを API の応答だけで厳密には判定できない。設計では (1) 2xx と 404 を「外せた」と扱い、(2) 解除済みの元のアカウントが後で友だち追加したときにも line-webhook が個別リンクを外す安全網を置く。本番の確認（Req 9.2）で GET の 404 を実測し、仮定を検証する

### dashboard-api へ LINE の資格情報を配ることの影響
- **Context**: Req 3.1 を同期で満たすには、dashboard-api が LINE を呼ぶ必要がある
- **Sources Consulted**: `infra/envs/prod/main.tf`（run-services の `secret_env`）、`infra/modules/run-services/main.tf:129`（`secret_env` ごとの `secretAccessor` 付与）、`infra/sql/grants.sql`
- **Findings**:
  - トークンの発行（stateless・`client_credentials`）には `LINE_CHANNEL_ID`（平文の env）と `line-channel-secret` が要る。この secret は Webhook の署名検証の鍵も兼ねる
  - run-services モジュールは `secret_env` に書けば `secretAccessor` を自動で付ける。新しい secret の枠は要らない
  - 発行したトークンは LINE の全操作（push を含む）に使える。権限を細かく絞る手段は無い
  - dashboard SA は既に `owners`・`stores`・`onboarding_sessions` の DML を持つ。DB を直接書き換える力は、Webhook を偽造する力より大きい
- **Implications**: 新しく増える力は「公式アカウントとしてメッセージを送れること」である。緩和策として、dashboard-api の LINE アダプタは解除の 1 操作しか公開せず、push の経路を持たない（→ Decision: LINE を呼ぶ層）

### 引継ぎを置く場所
- **Context**: Req 6.1–6.6、Out of scope「管理画面での付け替え」
- **Findings**: `StoreIdentificationService.confirmStore` は line-webhook の確定と dashboard-api の店舗登録の両方から呼ばれる（`dashboard-api/src/composition.ts:76`）。`confirmStore` の中で引き継ぐと、管理画面の登録も引継ぎになる
- **Implications**: 引継ぎは別のメソッドとして足し、line-webhook だけが配線する。dashboard-api の登録が「解除済みオーナーの Place → `place_already_registered`」のままであることを試験で固定する

### GBP の連携は店舗に付いて移る
- **Context**: Req 6.3（引継ぎで変えないもの）
- **Findings**: `oauth_tokens.store_id`・`gbp_locations.store_id` は店舗単位、`gbp_sessions.owner_id` はオーナー単位。店舗を移すと、前の担当者の Google アカウントで得たトークンが新しいオーナーの店舗に付いたままになる。本番は GBP が既定 OFF で、これらの表は空である
- **Implications**: 本 spec の境界の外とし、第2フェーズの有効化（関門 A）の前提条件として扱いを決める Issue を起票する（Revalidation Trigger に記載）

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| A: dashboard-api が DB と LINE の両方を扱う | 解除のルートで DB を確定し、コミット後に LINE を呼ぶ | 結果が同期で分かる。store-suspension と同じ形 | dashboard-api に LINE の資格情報が要る | **採用**（LINE の操作は解除だけに絞る） |
| B1: line-webhook の内部エンドポイントを呼ぶ | dashboard-api → line-webhook（サービス間認証） | 資格情報が広がらない | line-webhook は公開サービスで、パス単位の IAM が無い。アプリ内で ID トークンを検証する新しい認証面が要る | 不採用 |
| B2: 次のイベントで遅延して外す | 解除済みのアカウントが話しかけたら外す | 新しい資格情報が要らない | 話しかけてこないアカウントのメニューが残る。Req 3.1・9.2 を満たさない | **安全網としてだけ**採用（follow 時） |
| C: 共有パッケージへ切り出す | トークン発行とメニュー操作を `ts/packages/` に置く | 重複を減らす | 現時点の消費者は dashboard-api だけ。line-webhook の既存クライアントの移行まで含めると差分が増える | 不採用（Simplification） |

## Design Decisions

### Decision: 解除済みの表し方
- **Context**: Req 1.1, 4.1–4.4, 3.3
- **Alternatives Considered**:
  1. R1 — `line_user_id` を NULL にし、`line_unlinked_at` を足す
  2. R2 — `line_unlinked_at` だけ足し、UNIQUE を部分一意にする
  3. R3 — `line_user_id` に接頭辞を付けて付け替える（2026-10-24 の手作業）
- **Selected Approach**: R1 に、メニューを外し終えるまでの元の ID の列（`menu_pending_line_user_id`）を加える。CHECK で `line_unlinked_at IS NULL ⇔ line_user_id IS NOT NULL` と、`menu_pending_line_user_id` は解除済みのときだけ値を持つことを保証する
- **Rationale**: 旧 LINE ID の読み手の大半が構造的に解除を扱える。同じ LINE アカウントの再オンボーディングで UNIQUE に当たらない（PostgreSQL の UNIQUE は NULL を重複とみなさない）
- **Trade-offs**: `OwnerRow.line_user_id` が nullable になり、消費箇所の修正が要る（利点として、型検査が漏れを示す）
- **Follow-up**: 本番の既存行はすべて連携中なので、CHECK は既存行で成立する

### Decision: LINE を呼ぶ層
- **Context**: Req 3.1–3.4
- **Selected Approach**: 方式 A。dashboard-api に専用の小さなアダプタ（トークン発行と DELETE だけ）を置く。トークンはキャッシュしない（操作の頻度が低い）
- **Rationale**: 同期の表示（Req 3.2）を保てる。gap 分析では共有パッケージ（方式 C）を推奨したが、消費者が 1 つなので切り出しは見送る（Simplification）。トークン発行の実装は 3 つ目になる。統合は別 Issue で扱う
- **Trade-offs**: dashboard-api が公式アカウントの全操作をできる資格情報を持つ。アダプタの公開面を解除に限ることで緩和する

### Decision: 引継ぎは確定の別メソッド
- **Selected Approach**: `@fwlm/store-identification` に `confirmStoreForOnboarding` を足し、line-webhook だけが使う。旧オーナーの行を `FOR UPDATE` で施錠し、施錠後に Place の店舗の所有者を読み直すことで、同時確定を 1 つに絞る（Req 6.6）
- **Rationale**: 確定と引継ぎを 1 トランザクションにでき、既存の `confirmStore` の契約（dashboard-api が凍結契約として使う）を変えない

### Decision: オーナー一覧の取得
- **Context**: Req 2.1–2.5。既存の `GET /owners` は運営に代理店の指定を必須とし（400）、連携状態を返さない
- **Selected Approach**: `GET /owners` を拡張する。運営が代理店を指定しなければ全オーナーを返し、各行に担当代理店名・連携状態・メニュー未解除・店舗名を足す。店舗登録の画面は従来どおり代理店を指定して呼ぶ
- **Alternatives Considered**: 新しい一覧のルートを足す（同じ範囲の判定とクエリが二重になるので不採用）
- **Trade-offs**: `agency-dashboard` の契約（運営の未指定は 400）が変わる。店舗登録の画面は常に指定するので、振る舞いは変わらない

## Synthesis
- **Generalization**: 「運営・代理店の範囲つきの状態の切り替え＋変化したときだけ監査」は store-suspension と同じ形である。ハンドラとダイアログの構造を型紙としてそのまま使い、新しい抽象（共通の切り替えハンドラなど）は作らない（使う箇所が 2 つでは、抽象が読み手の負担になる）
- **Build vs. Adopt**: LINE SDK（`@line/bot-sdk`）は使わない。既存の 2 アプリも fetch で直接呼んでおり、依存を足すほどの面が無い（DELETE 1 本とトークン発行）
- **Simplification**: 共有 LINE パッケージ、トークンのキャッシュ、メニュー状態の定期照合ジョブ、解除の取り消し操作、管理画面の付け替えを持たない。メニューの未解除は列 1 つで表し、外し直しは解除と同じルートの再実行で表す

## Risks & Mitigations
- ブロック中のアカウントへの解除が黙って失敗する — follow 時の安全網と、本番での GET の実測（Req 9.2）
- 列単位の GRANT の再適用で REVOKE が空振りする（付与者の食い違い）— store-suspension と同じく、本番で `has_column_privilege` を照会してからマージする
- `OwnerRow` の型変更が既存の試験の偽物に波及する — 型検査で全箇所を洗い出し、変更を 1 タスクに閉じる
- open PR #472 と `conversation.ts` で衝突する — 引継ぎの変更は `handleConfirm` の分岐に限る。#472 は招待コードの段階を触るので、衝突は小さい

---

# Design Review（/kiro-validate-design・2026-10-24）

判定: GO（条件付き）。指摘 3 点を design.md へ反映した。

1. **手作業の切り離し行（`detached-` 接頭辞）が移行に無かった。** CHECK の上では連携中に見え、引継ぎを拒み、配信が存在しない宛先へ push し続ける。→ Migration Strategy に一回限りの変換手順（照会・退避・件数の突き合わせ）を追加
2. **招待コードは多用途で期限が無い**（`agency_invite_codes` は `disabled_at` でしか失効しない）。解除済みの店舗は、同じコードを知る別のアカウントが引き継げる。→ ユーザーの決定（2026-10-24）: 期限は設けず、残るリスクと復旧手順を明記し、オーナー一覧で引継ぎ先を表示する。要件 2.6 を追加し、`owners.taken_over_by_owner_id` を足した（監査記録は #250 によりベストエフォートなので、表示の根拠を監査から導かない）
3. **dashboard-api の必須 env の追加が `check-spec-env-names.sh` を赤にする。** `store-qr-issuance-ui/tasks.md:175` の env 宣言表が `dashboard-api/src/config.ts` の必須 env と照合されている。→ File Structure Plan に表と試験の env を追加。LINE アダプタは `fetch` を注入し、試験から `api.line.me` へ出ない

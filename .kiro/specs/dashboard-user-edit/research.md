# Research & Design Decisions — dashboard-user-edit

## Summary
- **Feature**: `dashboard-user-edit`
- **Discovery Scope**: Extension（`agency-dashboard` と `dashboard-user-lifecycle` が作った利用者管理を拡張する。新しい外部依存は無い）
- **Key Findings**:
  - 運営の降格は「有効な運営を 1 人減らす」点で無効化と同型である。既存の保護（`disableDashboardUserGuarded` の advisory lock と残数判定）と**同じロックキー**を取れば、降格と無効化を互いに直列化できる。ロックのクラスを別にすると、降格×無効化の write-skew で運営が 0 人になる。
  - 監査の action は `audit_logs` の列 CHECK（実名 `audit_logs_action_check`・0007）で 12 値に閉じている。新しい action を記録するには migration が要る。新しいコードが先に出ると、書込は確定するのに監査が CHECK 違反で落ち、#250 の経路に入る。
  - 全項目を送る更新は、同時編集のときに他の運営の変更を黙って巻き戻し、実態と異なる監査記録（「A が降格した」）を生む。変更した項目だけを送る部分更新にすれば、スキーマを変えずに防げる。

## Research Log

### 既存の利用者管理の構造（拡張点）
- **Context**: 編集をどこへ足すかを決めるため。
- **Sources Consulted**:
  - `ts/apps/dashboard-api/src/app.ts`（`AppDeps.admin`・ルート配線・CORS `allowMethods: ['GET','POST']`）
  - `ts/apps/dashboard-api/src/admin.ts`（`requireOperatorUser`・`UUID_RE`・`parseCreateUserBody`・監査の呼び出し）
  - `ts/packages/db/src/dashboard-users.ts`（`disableDashboardUserGuarded`・`DISABLE_LOCK_CLASS = 0x64756c31`・`DASHBOARD_USER_COLUMNS`）
  - `.kiro/specs/dashboard-user-lifecycle/design.md`（並行ガードの正当性・「有効な運営」の定義）
- **Findings**:
  - 依存方向は `types` → `pool` → DAL → ハンドラ（純関数＋依存注入）→ ルート → 合成根（`index.ts`）。dashboard-web は HTTP 経由。
  - 状態を変える操作は POST のサブパス（`/disable`・`/enable`）で表す慣習がある（agency-dashboard design.md:424）。CORS は GET と POST しか許可していない。
  - 自己判定は `req.id.toLowerCase()` で正規化してから `guard.user.id` と比べる。UUID の正規表現は大文字小文字を区別しないため、正規化しないと大文字表記で自己判定をすり抜ける（#34 の教訓）。
  - 利用者の作成で他運営の代理店を指定すると 23503 が 500 になる既存の不具合がある（#260）。編集では同じ穴を開けないよう、トランザクション内で所属先を事前に確かめる。
- **Implications**: 新しいルートは `POST /dashboard-users/:id/update`。DAL・ハンドラ・ルート・合成根・web のすべてで、既存の型をそのまま踏襲する。

### 監査記録の制約（0007）
- **Context**: 編集の監査に使える action が既存に無い。
- **Sources Consulted**: `db/migrations/0007_audit_logs.sql`、`ts/packages/db/src/audit-logs.ts`、Issue #231・#250・#252。隔離 DB（`ts/scripts/with-test-db.sh`）で `pg_constraint` を実測した。
- **Findings**:
  - action は名前の無い列 CHECK として宣言されており、実名は `audit_logs_action_check`（2026-09-13 実測）。表の所有者は migration を当てたロール（テストでは `postgres`）。
  - payload の列は無い。変化の向きを残すには action 名に向きを持たせるしかない。
  - TS の `AuditLogAction` 型と DB の CHECK の集合を照合する仕組みが無い。#252（店舗の利用停止）も action を足す予定で、CHECK を作り直すときに相手の値を落とす事故は、migration 番号のガード（`check-db-ordinals.sh`）では検出できない。
  - dashboard-api は業務の書込を確定した**後**に監査を書き、失敗を握らない（#250・未決）。
- **Implications**:
  - 0009 で CHECK を明示名 `ck_audit_logs_action` として作り直す。後の migration が名前を推測しなくて済む。
  - TS の action 一覧を `as const` の配列に変え、DB の CHECK と集合が一致することをテストで固定する。
  - 本番では 0009 を新しいコードより先に当てる。

### 画面の型（行直下パネル）
- **Context**: 設計正典 `docs/design/design-language.md` §7.5 は Dialog・Popover・Toast を禁じている。
- **Sources Consulted**: `ts/apps/dashboard-web/src/app/stores/page.tsx`（`openStoreId`・`triggerRef`・`BASE_COLUMN_COUNT`・Fragment による行の挿入）、`ts/apps/dashboard-web/src/components/store-qr-panel.tsx`（`Card size="sm"`・`Heading level={2}`・コードから文言を引く `Map`・`focusableWhenDisabled`）、`.kiro/specs/ui-airbnb-foundation/design.md` D6。
- **Findings**:
  - 行直下パネルは「唯一の完成形」と明記されている。選択部品は標準の `<select>` をラップした `@fwlm/ui` の `Select` を使う（テストがプログラムから値を変える）。
  - 同じ URL の中で進む状態（パネルが開いた状態）は、a11y 監査の面一覧から構造的に漏れる（Issue #179 の前例）。面一覧に明示的に足す必要がある。
  - `me.displayName` を描いている箇所は無く、`auth-context` は `/me` をログイン時に 1 回取るだけで、取り直す手段を持たない。
- **Implications**:
  - 新しい部品 `DashboardUserEditPanel` を QR パネルと同型で作る。
  - E2E に `openUserEditPanel` を足し、`DASHBOARD_SURFACES` に登録する。
  - 自分の表示名を変えても `me` を取り直す必要は無い。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 全項目を送る更新（PUT 的） | パネルの全項目を毎回送る | 実装が単純 | 同時編集で他人の変更を巻き戻し、虚偽の監査を生む | 不採用 |
| 期待値の照合（楽観ロック） | 開いた時点の値を `expected` として送り、食い違えば 409 | 同じ項目の競合も検出できる | 409 の状態と画面の回復導線が増える。`updated_at` 列も無い | 不採用（過剰） |
| **変更した項目だけを送る（部分更新）** | 変更したロール・所属・表示名だけを送る | 異なる項目の同時変更で巻き戻しが起きない。スキーマ変更なし | 同じ項目の同時変更は後勝ち | **採用**（Req 3.1〜3.3 と一致） |

## Design Decisions

### Decision: 降格の保護を無効化と同じロックで直列化する
- **Context**: Req 2.3・2.5。降格と無効化はどちらも有効な運営の数を減らす。
- **Alternatives Considered**:
  1. 降格専用のロッククラスを作る
  2. `SELECT ... FOR UPDATE` で対象行だけを固める
  3. 無効化と同じ `(0x64756c31, hashtext(operatorId))` を取る
- **Selected Approach**: 3。トランザクションの最初に同じ advisory lock を取り、対象の取得 → 所属先の確認 → 残数の判定 → UPDATE を直列に行う。
- **Rationale**: 1 では降格×無効化が互いに見えず write-skew が起きる。2 では残数判定が他の行に依存するため防げない。3 は lifecycle で正当性を示した機構をそのまま広げるだけで済む。
- **Trade-offs**: 同じ運営の中の管理操作がすべて直列になる。管理操作は低頻度なので無害。
- **Follow-up**:
  - 定数名は `OPERATOR_GUARD_LOCK_CLASS` へ改名するが、**値は変えない**。Cloud Run のリビジョン切替中は旧コードの無効化と新コードの降格が並走するため。
  - テスト側は定数を import せずリテラル `0x64756c31` を持ち続ける。値を変えたらテストが赤くなる番人として働く。

### Decision: 存在秘匿のための判定順序
- **Context**: Req 4.3・4.4・4.5。
- **Selected Approach**: 対象の利用者を運営で絞って取得してから、所属先の代理店を運営で絞って確かめる。
- **Rationale**: 逆順だと、他運営の利用者に他運営の代理店を指定したときに `agency_not_found` が返り、「その利用者は存在する」ことが漏れる。
- **Follow-up**: 「他運営の利用者＋他運営の代理店」で `not_found` になることを DAL のテストで固定する。

### Decision: 監査の action は向きを名前に持たせ、差分は DB の前後の行から取る
- **Context**: Req 5.1〜5.5。payload の列は無い。
- **Selected Approach**: 追加する action は次の 4 つ。
  - `dashboard_user_promoted_to_operator`
  - `dashboard_user_demoted_to_agency`
  - `dashboard_user_agency_updated`
  - `dashboard_user_display_name_updated`
  
  前後の行から純関数で導出し、変化が無ければ書かない。
- **Rationale**:
  - 属性の変更は既存の命名 `store_category_updated` に揃えて `_updated` とする。ロールの変更は向きそのものを名前にする。
  - 入力値と比べると、大文字の UUID を「変化あり」と誤判定する。
- **Trade-offs**: 旧ロール・旧代理店の値そのものは残らない（Out of scope として requirements に明記済み）。

### Decision: 部分更新の body 形（validate-design で改訂・2026-09-13）
- **Context**: Req 3.1・3.4。
- **初版**: 所属の変更も常に `{ role: 'agency', agencyId }` として送り、role が無いときは agencyId を受け付けなかった。
- **初版の欠陥**（`/kiro-validate-design` の Critical Issue 1）: 次の順で、所属の変更が降格として実行されてしまう。
  1. 運営 A が利用者 X（代理店・ag1）のパネルを開いたまま置く。
  2. その間に運営 B が X を昇格させる。
  3. A が所属を ag2 に変えて保存する。
  
  結果として X は代理店へ戻され、監査にも「A が降格した」と残る。要件 3 の目的（意図しない権限の変更と、実態と異なる監査を防ぐ）に反する。
- **Selected Approach**（ユーザー決裁 2026-09-13）: 「ロールを変える」と「代理店ロールのまま所属を移す」を body で区別する。
  - `role` がある: ロールを変える。ロールと所属の組み合わせ規則（作成と同じ）で agencyId を検証する。
  - `role` が無く `agencyId`（UUID）がある: 所属の移動。サーバはロックの中で、対象がまだ代理店ロールであることを確かめる。違えば 409 `role_changed` を返し、何も変えない。
  - displayName は、キーがあれば更新する（null なら未設定にする）。
  - 何も変更が無い body は 400。
- **Rationale**: 所属の移動は「代理店ロールであること」を前提にした操作である。その前提が崩れていれば、推測で降格させずに止めるのが正しい。
- **Trade-offs**: DAL の結果に 1 種類、画面の文言に 1 行が増える。同じ項目（ロール同士・所属同士）の同時変更は、引き続き後勝ちとする。

### Decision: 代理店一覧を取得できないときの表示（validate-design で追加・2026-09-13）
- **Context**: Req 1.1・1.14。既存の画面は `GET /agencies` の失敗を黙って捨てる（`page.tsx:72`）。そのため、パネルの所属欄に現在の所属が選択肢として無く、「未選択」に見えてしまう。
- **Selected Approach**（ユーザー決裁 2026-09-13）: 画面が `agenciesFailed` を持つ。失敗していれば、パネルはロールと所属を固定表示にして理由を案内し、表示名だけを受け付ける。登録フォームの既存の挙動は変えない。

### Known Risk: 行為者の権限の鮮度（validate-design で記録・2026-09-13）
- 行為者自身が同時に降格・無効化されると、処理中の 1 要求だけは運営として完了しうる（ミリ秒単位の窓）。
- 既存の無効化にも同じ形で存在する。本仕様だけで塞ぐと挙動が揃わないため、今回は design に既知のリスクとして記すにとどめる。
- 不変条件（有効な運営が 0 人にならない）は、この窓があっても保たれる。

### Generalization / Build vs Adopt / Simplification
- **Generalization**: ロールと所属の組み合わせの検証は、作成と編集で同じ規則である。`parseRoleScope` として切り出して共有する。表示名は、作成では trim しない既存の挙動を変えないため、共有しない。
- **Build vs Adopt**: 新しいライブラリは入れない。検証は既存どおり `unknown` を手で絞り込む（zod は依存に無い）。画面部品は `@fwlm/ui` の既存部品（Card・Heading・Select・Input・Button・Alert）だけで組む。
- **Simplification**:
  - 楽観ロックも `updated_at` 列も足さない（部分更新で要件を満たすため）。
  - `me` の取り直しの仕組みも足さない（描かれていないため）。
  - `auditActionsForUserUpdate` は、ハンドラと同じモジュールの純関数にとどめる（2 つ目の利用者がいないため）。

## Risks & Mitigations
- **0009 より先に新しいコードが本番に出る** → 監査が CHECK 違反で落ち、しかも再試行では差分が無いので監査が二度と戻らない。migration のヘッダ・design・tasks の最終タスク・PR 本文の 4 箇所に「0009 を先に当てる」と書く。適用を確かめるクエリを添える。
- **#252 が CHECK を作り直すときに、本仕様の値を落とす** → TS と CHECK の集合一致テストで検出する。#252 にはコメント済み（2026-09-13）。
- **携帯端末の幅で、パネルが表の中で右にはみ出す** → 横スクロールの実測（E2E）と、実ブラウザでの確認（review-gate）。
- **既存の完全一致テスト（利用者管理の画面）が 8 箇所前後壊れる** → 画面へ統合するタスクの中で同時に直す。

## References
- `.kiro/specs/dashboard-user-lifecycle/design.md` — 並行ガードの正当性と「有効な運営」の定義
- `.kiro/specs/agency-dashboard/design.md` — RBAC・POST サブパスの慣習（:424）・認可の真実は DB（:587）
- `.kiro/specs/store-qr-issuance-ui/design.md` — 行直下パネルの前例
- `docs/design/design-language.md` §7.5 — Dialog・Popover・Toast の禁止
- Issue #231（audit_logs）・#250（監査の失敗の扱い）・#252（action の追加が重なる）・#260（作成での 23503）

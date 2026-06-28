# Research & Design Decisions

## Summary
- **Feature**: `four-tier-data-model`
- **Discovery Scope**: New Feature（greenfield・基盤データモデル）
- **Key Findings**:
  - Operator / Agency のダッシュボードログインは「認証主体(dashboard_user)」と「テナント実体(operator/agency)」を分離することで一般化でき、RBAC を単一表で表現できる。
  - 自店と競合は「測定対象プレイス」という同一概念の変種であり、時系列(`rating_snapshots`)を store コンテキスト＋subject_kind で統一表現できる。
  - 来店客の匿名性は「個別回答/顧客を格納する表を一切作らない」ことで構造的に保証する（カラム制約ではなく不在による保証）。
  - 書き込み境界は「Places API 由来データ = Go バッチ／LINE・ダッシュボード・アンケート由来 = TS」でテーブルが自然に二分される。

## Research Log

### 外部依存の扱い（Places / GBP / Identity Platform / LINE）
- **Context**: 本モデルは外部 ID（Google Place ID・LINE userId・Identity Platform subject）を保持する。
- **Findings**:
  - Google Place ID は不透明な文字列で、稀に変化しうる（再解決が必要）。固定長を仮定せず `text` で保持し、未確定状態を許容する。
  - LINE userId は単一公式アカウント配下で安定・一意な不透明文字列（`U` + 英数）。`text` 一意制約で十分。
  - Identity Platform / Firebase Auth の subject(uid) は不透明文字列。資格情報は基盤側が保持し、本モデルは subject 参照のみを持つ（パスワード等は一切保持しない）。
- **Implications**: 外部 API の取得契約（Places nearby search のレスポンス整形・GBP OAuth フロー）は本 spec の範囲外。本モデルは「識別子の格納と一意性」のみを所有し、取得処理は機能1／第2フェーズの spec が所有する。

### 識別子戦略（代理キー vs 自然キー）
- **Findings**: 各エンティティに UUID 代理主キー（`gen_random_uuid()`, PostgreSQL 13+ 標準）を採用し、自然キー（place_id・line_user_id・auth_subject）は一意制約で表現。
- **Implications**: 階層の FK 連鎖を安定させ、自然キーの変化（Place ID 再解決）に強い。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | 判定 |
|--------|-------------|-----------|---------------------|------|
| 共有スキーマ + リネージ FK + アプリ層 RBAC | 全テナントを単一スキーマに格納し、`owner.agency_id` 連鎖でスコープ判定。ダッシュボード API がロールで絞り込む | 単純・単一 Cloud Run API で完結・MVP に適合 | アプリ層の絞り込み漏れリスク（テスト/レビューで担保） | **採用** |
| PostgreSQL Row-Level Security (RLS) | DB ポリシーでテナント分離 | DB 強制で漏れにくい | ポリシー運用が重く、2 言語×バッチ接続のロール設計が複雑化。MVP 過剰 | 却下（将来の強化候補） |
| スキーマ/DB 分離マルチテナント | テナントごとに schema/DB | 強い分離 | 店舗数スケールで運用爆発・横断集計困難 | 却下 |

## Design Decisions

### Decision: Operator/Agency と dashboard_user の分離（一般化）
- **Context**: Req3（運営・代理店が同一ダッシュボードにログインし RBAC 分離）と Req1（4 階層の親子）。
- **Alternatives**:
  1. `operators` / `agencies` 各表に認証情報を直付け
  2. テナント実体（`operators`/`agencies`）と認証主体（`dashboard_users`）を分離
- **Selected**: 2。`dashboard_users(role, operator_id, agency_id, auth_subject)` を導入。role=operator は agency_id=NULL（全体）、role=agency は agency_id 必須（担当のみ）。CHECK 制約で整合。
- **Rationale**: ログインという横断関心をテナント階層から切り離し、Req2 の RBAC スコープを単一表で一般化。将来 1 代理店に複数スタッフも無改造で対応。
- **Trade-offs**: 表が 1 つ増えるが、認証と階層の責務が明確化。

### Decision: 自店・競合を統一する時系列 `rating_snapshots`
- **Context**: Req7（自店＋競合の評価・順位を時系列で追記）。
- **Selected**: `rating_snapshots(store_id, subject_kind('self'|'competitor'), competitor_id, place_id, captured_on, rating, review_count, rank)`。`store_id` が競合文脈、`subject_kind`/`competitor_id` が測定対象。追記専用。
- **Rationale**: 自店と競合を別表に分けず、日次サマリーの 1 クエリで自店＋競合を取得可能（Req7.4）。
- **Trade-offs**: ポリモーフィック気味だが CHECK と部分一意 index で整合を強制。

### Decision: 匿名集計は「個別回答表を作らない」ことで保証
- **Context**: Req8（個人情報非取得・個別回答非永続化・Place 単位匿名集計のみ）。
- **Selected**: 顧客表・個別回答表を**スキーマに一切設けない**。`survey_rating_tallies` / `survey_aspect_tallies` のカウンタ表のみ（store_id × 期間 × 次元 → 件数）。自由記述「一言」は TS 層が AI 下書き生成時に一過性で扱い、**どこにも書き込まない**。
- **Rationale**: 制約での防御ではなく「格納先の不在」による構造的保証。Req8.4 を最強に満たす。
- **Trade-offs**: 後から個別分析はできない（要件上むしろ正しい）。

### Decision: 書き込み境界＝データ源でテーブルを二分
- **Context**: Req9（各テーブル単一書込責任層）。
- **Selected**:
  - **Go 日次バッチ層が書く**: `competitors`, `rating_snapshots`（Places API 由来）
  - **TS リアルタイム応答層が書く**: `operators`, `agencies`, `dashboard_users`, `owners`, `stores`, `survey_rating_tallies`, `survey_aspect_tallies`, （将来）`oauth_tokens`
  - **マイグレーション(seed)が書く**: `categories`, `survey_aspects`（共有定数 SoT、実行時はどちらも書かない・両層 read）
- **Rationale**: データ源で自然に分離し、二重書き込みを構造的に排除。共有定数は単一 seed を SoT 化し二重定義を防止（Req9.3）。

### Decision: 時系列のパーティショニングは将来送り
- **Context**: `rating_snapshots` は日次×（自店+競合5）で増加。
- **Selected**: MVP は単一表 + `(store_id, captured_on)` index。`captured_on` 月次の宣言的パーティションは将来オプションとして記録のみ。
- **Rationale**: Simplification。MVP 規模で前倒し最適化は不要。インターフェース（テーブル形）は不変なので後付け可能。

### Decision: OAuth トークンは「店舗単位」で構造枠を確保（validate-design で改訂）
- **Context**: Req10（第2フェーズ・4 階層を壊さない）。
- **Alternatives**:
  1. `oauth_tokens(owner_id, ...)`（オーナー単位）
  2. `oauth_tokens(store_id, ...)`（店舗単位）
- **Selected**: 2。`oauth_tokens(store_id, provider, ...)`。GBP は店舗(Place)ロケーション単位の認可であり、1 オーナー:N 店舗を確定した以上トークンは店舗ごとに必要。テナント隔離は store→owner→agency。MVP は定義のみ・実データ運用なし。
- **Rationale**: 初版の owner 単位では複数店舗を捌けず、第2フェーズで構造再編が発生する。本 spec の「後から壊さない」趣旨に反するため店舗単位へ改訂。
- **Trade-offs**: 1 オーナー1店舗運用でも冗長にならず、多店舗で自然。

### Decision: 競合の churn を論理非活性化で吸収（validate-design で追加）
- **Context**: Req6/Req7。競合は Go バッチが Places から更新し、1km 圏外への離脱・入れ替わりが起きる。`rating_snapshots.competitor_id` は FK(`ON DELETE RESTRICT`) のため、競合をハード削除すると過去スナップショットが破損する。
- **Selected**: `competitors.active boolean` を導入し**ハード削除しない**。比較集合は「自店 + active 競合」。スナップショットは `place_id` を非正規化保持し履歴を自立生存させる。
- **Rationale**: 履歴の再現性（Req7.2/7.3）を守りつつ、競合集合の動的更新を可能にする。
- **Trade-offs**: 非活性行が蓄積するが、index/クエリで `active` を絞れば実害なし。

### Decision: rank の順位集合・指標を確定（validate-design で追加）
- **Context**: Req7.2「導出された順位」。格納カラム `rank` の意味が未定義だと下流実装が割れる。
- **Selected**: `rank` = `store_id` の比較集合 {自店 + 当日 active 競合} 内の当日順位。指標は星評価降順、同点は review_count 降順。算出は Go バッチ責務、本モデルはカラム意味のみ確定し point-in-time 保持。
- **Rationale**: 格納値の意味を固定し、機能1 実装の解釈ブレを排除。

### Decision: 複合 FK と place CHECK による整合性ハードニング（PR #9 レビュー対応）
- **Context**: 実機 INSERT で 4 件の整合性の穴を再現（クロスオペレータ RBAC・競合の店舗境界破れ・place_status/place_id 非連動・匿名性 denylist の脆弱性）。
- **Selected**:
  1. `agencies UNIQUE(operator_id, id)` ＋ `dashboard_users(operator_id, agency_id) → agencies(operator_id, id)` 複合 FK。
  2. `competitors UNIQUE(store_id, id)` ＋ `rating_snapshots(store_id, competitor_id) → competitors(store_id, id)` 複合 FK。
  3. `stores CHECK ((place_status='confirmed') = (place_id IS NOT NULL))`。
  4. `30_compliance.sql` を allowlist 化（既知 12 テーブル／tally 固定列）。テーブル allowlist は新テーブル追加時のレビューゲートを兼ねる。
- **Rationale**: 「確定構造でテナント隔離」という spec の主眼を、CHECK/アプリ規律でなく**参照整合性そのもの**で構造強制。MATCH SIMPLE 既定により operator/self の NULL 行は自然に非適用となり、既存の正当データ・テストを壊さない。
- **Trade-offs**: 複合 FK の参照先として冗長な複合 UNIQUE を 2 つ追加するが、構造保証の価値が上回る。

## Risks & Mitigations
- アプリ層 RBAC の絞り込み漏れ — リネージ FK を NOT NULL 化し orphan を構造的に排除＋スコープ判定をテストで担保。将来 RLS で多層防御可能。
- ポリモーフィック `rating_snapshots` の整合 — CHECK 制約（subject_kind と competitor_id の相関）＋部分一意 index で防御。
- 書き込み境界の規律はコードでは強制されない — `db/write-boundary.md` を SoT 化し、レビューで違反を検出。将来は DB ロール権限で物理強制も可能。
- Place ID 変化 — `text`・部分一意（確定時のみ）・未確定状態許容で吸収。

## References
- PostgreSQL: `gen_random_uuid()`（13+ 標準）, 部分一意インデックス, CHECK 制約, 宣言的パーティショニング — 標準機能。
- 一次情報源: `requirements.md`（2.3 / 5.1 / 5.2）, `.kiro/specs/four-tier-data-model/requirements.md`, `.kiro/steering/`。

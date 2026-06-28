# Requirements Document

## Introduction

本仕様は fw-line-meo（飲食店向け LINE × MEO 製品）の**最初の基盤**となる **4 階層データモデル**を確定するものである。

4 階層は「運営（Operator）→ 代理店（Agency）→ 飲食店オーナー（Owner）→ 来店客（Customer・匿名）」であり、**初期から確定構造**として設計する（後からの階層挿入は不可）。Store（店舗）は Owner が所有する独立エンティティであり、1 オーナーは複数店舗を持ちうる（1:N）。この構造を先に固めないと後続の全機能（機能1・機能3 ほか）が手戻りリスクを負うため、本仕様の成果物は ER 図と スキーマ DDL をレビュー済みでリポジトリに格納することを完了条件とする。

本仕様が定めるのは**データモデルが満たすべき構造・整合性・境界の制約（WHAT）**であり、各機能の実装ロジックや具体的なテーブル定義の物理設計（HOW）は design 以降で扱う。

出典: GitHub Issue ManatoYamashita/fw-line-meo#1。参照: `requirements.md`（2.3 / 5.1 / 5.2）、`.kiro/steering/`。

## Boundary Context

- **In scope（本仕様が所有する範囲）**
  - 4 階層（Operator / Agency / Owner / Customer）の構造と所属整合性
  - エンティティ: Operator、Agency、Owner、Store、競合プレイス（Competitor）、評価・順位の時系列、アンケート匿名集計、（将来枠としての）OAuth トークン
  - マルチテナント分離を支えるリネージ（各レコードが上位階層へ一意に辿れること）
  - 書き込み境界（各テーブルの書込責任層）の定義文書
  - 来店客の匿名性・個人情報非取得の構造的保証
  - 成果物（ER 図・スキーマ DDL）のレビューと格納

- **Out of scope（本仕様が所有しない範囲）**
  - RBAC の実行時アクセス制御コード、LINE Webhook・オンボーディング処理、Places API 取得処理、アンケート Web UI・AI 下書き生成、ダッシュボード実装
  - Google OAuth 連携・GBP 機能の実装（第2フェーズ）。本仕様では将来の格納枠を構造的に阻害しないことのみを担保する
  - マイグレーション実行基盤、バックアップ・保持運用、データストア製品固有の設定

- **Adjacent expectations（隣接システムへの期待）**
  - 外部認証プロバイダが Operator / Agency のダッシュボードログイン用 ID とロールを供給する
  - リアルタイム応答層と日次バッチ層が書き込み境界に従って各テーブルを読み書きする
  - 単一の LINE 公式アカウントが Owner 解決に用いる LINE ユーザ識別子を供給する
  - 下流の MVP 機能（機能1・機能3）は本モデルが先に確定していることに依存する

---

## Requirements

### Requirement 1: 4 階層の階層構造と所属整合性
**Objective:** データ基盤設計者として、4 階層の所属関係を構造的に強制したい。それにより後続機能が階層を前提に安全に構築でき、後からの階層挿入による手戻りを防げる。

#### Acceptance Criteria
1. The Data Model shall 「Operator → Agency → Owner → Customer（匿名）」の 4 階層を、後から中間階層を挿入せずに表現できる確定構造として保持する.
2. When 新しい代理店が登録される, the Data Model shall その代理店を 1 つの上位運営スコープに必ず紐づける.
3. When 新しいオーナーが登録される, the Data Model shall そのオーナーを ちょうど 1 つの親代理店に紐づける.
4. When 新しい店舗が登録される, the Data Model shall その店舗を ちょうど 1 つの所有オーナーに紐づける.
5. If 親レコード（代理店・オーナー）が存在しない状態で子レコードを作成しようとする, then the Data Model shall その作成を拒否する.
6. The Data Model shall 1 オーナーが複数店舗を所有する関係（1:N）を、構造変更なしで表現できる.

### Requirement 2: マルチテナント分離とアクセス境界の支持
**Objective:** 運営・代理店として、自分の権限範囲のデータだけを安全に辿りたい。それにより代理店が他代理店の店舗を閲覧できないテナント分離が成立する。

#### Acceptance Criteria
1. The Data Model shall すべての店舗とオーナーを、その上位の代理店へ一意に辿れるリネージとして保持する.
2. While 閲覧者が代理店ロールである, the Data Model shall 取得可能なオーナー・店舗・集計を当該代理店配下のものに限定できる構造を提供する.
3. While 閲覧者が運営ロールである, the Data Model shall すべての代理店・オーナー・店舗を取得可能とする構造を提供する.
4. If あるレコードが上位代理店へ辿れない（リネージ欠落）, then the Data Model shall そのレコードを不整合として拒否または検出可能にする.

### Requirement 3: 運営・代理店エンティティとダッシュボード認証連携
**Objective:** 運営として、運営と代理店を同一ダッシュボードでロール分離して扱いたい。それにより RBAC による権限分離が認証基盤と一貫して機能する。

#### Acceptance Criteria
1. The Data Model shall 各 Operator と各 Agency を、外部認証プロバイダが発行する認証アイデンティティに紐づける.
2. The Data Model shall 各 Operator と各 Agency に対しロール（運営 / 代理店）を保持する.
3. Where ダッシュボードアクセスが対象となる, the Data Model shall 同一ログイン基盤上でロールに基づく閲覧範囲の差（運営=全体 / 代理店=担当のみ）を支持する.
4. The Data Model shall 認証アイデンティティに資格情報（パスワード等の秘匿情報）を一切保持しない.

### Requirement 4: オーナーエンティティと LINE 識別子による解決
**Objective:** 運営として、LINE イベントから担当オーナーと店舗を一意に解決したい。それにより単一公式アカウントのマルチテナント運用が成立する。

#### Acceptance Criteria
1. The Data Model shall 各オーナーに対し、全オーナー間で一意な LINE ユーザ識別子を保持する.
2. When LINE ユーザ識別子を伴うイベントが到着する, the Data Model shall その識別子から ちょうど 1 つのオーナーを解決できる.
3. The Data Model shall 解決したオーナーから、そのオーナーが所有する 1 つ以上の店舗を辿れる.
4. If 既存オーナーと同一の LINE ユーザ識別子で別オーナーを登録しようとする, then the Data Model shall その登録を拒否する.

### Requirement 5: 店舗エンティティ（Place ID・場所・カテゴリ）
**Objective:** データ基盤設計者として、店舗を外部プレイスと一意に対応づけたい。それにより競合取得や評価追跡が正しい対象に対して行える。

#### Acceptance Criteria
1. The Data Model shall 各店舗に対し Google Place ID、場所（位置情報）、カテゴリを保持する.
2. The Data Model shall 確定済みの Google Place ID を、対応プレイスの一意識別子として扱う.
3. While 店舗がオンボーディングの店舗特定を完了していない, the Data Model shall Place ID が未確定の状態の店舗の存在を許容する.
4. When 店舗の Place ID が確定する, the Data Model shall その Place ID の一意性を強制する.
5. The Data Model shall 店舗のカテゴリを、2 言語間で共有される単一のカテゴリ定義から参照する.

### Requirement 6: 競合リストと対象プレイス
**Objective:** 運営として、各店舗に対する競合の集合を保持したい。それにより機能1 の競合ポジショニングを評価対象として追跡できる。

#### Acceptance Criteria
1. The Data Model shall 各店舗に対し、競合プレイスの集合を関連づける.
2. The Data Model shall 各競合プレイスに対し Place ID と識別属性（名称・場所等）を保持する.
3. Where MVP スコープが適用される, the Data Model shall 1 店舗あたり少なくとも 5 件の競合プレイスを関連づけられる.
4. The Data Model shall 競合選定の業務ルール（半径約 1km・最大 5 件）を投入処理側の責務とし、モデル自体は競合の所属関連づけ以上の制約を課さない.

### Requirement 7: 評価・順位の時系列
**Objective:** 運営として、自店および競合の評価推移を時系列で保持したい。それにより日次サマリーと将来の傾向分析が再現可能になる。

#### Acceptance Criteria
1. When 日次スナップショットが記録される, the Data Model shall 追跡対象の各プレイス（自店および競合）について、タイムスタンプ付きの評価レコードを追記する.
2. The Data Model shall 評価（星評価・クチコミ総数）および導出された順位を、過去レコードを上書きしない追記型の時系列として保持する.
3. The Data Model shall 各時系列レコードを、それが属する店舗の競合文脈と、測定対象プレイスの双方へ関連づける.
4. While 日次サマリーを算出する, the Data Model shall ある店舗とその競合について、最新および過去の評価・順位を取得できる.

### Requirement 8: 来店客の匿名性とアンケート匿名集計
**Objective:** 運営として、来店客の個人情報を一切持たずアンケートを匿名集計のみで保持したい。それにより Google 規約とプライバシー方針への準拠を構造的に保証する。

#### Acceptance Criteria
1. The Data Model shall 来店客に関する個人を識別しうる情報（氏名・連絡先・端末識別子等）を一切保持しない.
2. When アンケート回答が処理される, the Data Model shall Place 単位の匿名集計のみを永続化し、個別回答そのものは永続化しない.
3. The Data Model shall 来店客を、識別子を持たない匿名の集計寄与としてのみ表現する.
4. If 個別回答または来店客の識別情報を永続化しようとする書き込みが発生する, then the Data Model shall その書き込みを許容しない構造とする.
5. The Data Model shall アンケート匿名集計を Place 単位のキーで保持し、オーナー向け付加価値（例: 当月★4 以上が N 件）として参照可能にする.

### Requirement 9: 書き込み境界（Write Boundary）の定義
**Objective:** データ基盤設計者として、同一 DB を 2 言語から触る際の書き込み責務を一意に定めたい。それにより二重書き込みや定数の不整合という運用事故を防ぐ。

#### Acceptance Criteria
1. The Data Model documentation shall 各テーブルについて、書き込み責任を負う層を ちょうど 1 つ（リアルタイム応答層 または 日次バッチ層）に割り当てて明記する.
2. The Data Model shall 各テーブルの読み取りを両層に許容しつつ、書き込み責務を単一層に限定する境界を成立させる.
3. Where 共有定数（カテゴリ定義等）が両層から参照される, the Data Model shall 単一の真実の源（Source of Truth）を定義し、定義の二重化による乖離を防ぐ.
4. When 新しいテーブルが追加される, the Data Model documentation shall その書込責任層を必ず明記することを要件とする.

### Requirement 10: 将来の OAuth トークン格納枠（任意機能・第2フェーズ）
**Objective:** 運営として、第2フェーズの Google OAuth 連携を、4 階層を壊さずに後から追加したい。それにより MVP の構造を将来拡張のために再設計せずに済む。

#### Acceptance Criteria
1. Where Google OAuth 連携が対象となる（第2フェーズ）, the Data Model shall OAuth トークンを所有アクターに紐づけて格納できる.
2. Where OAuth トークンを格納する, the Data Model shall それを既存のテナント分離スコープ配下に隔離する.
3. The Data Model shall 将来の OAuth トークンエンティティの追加を、4 階層の構造を再編せずに受け入れられる.
4. The Data Model shall MVP では OAuth トークンの実データ運用を範囲外とし、構造的な格納枠の確保のみを担保する.

### Requirement 11: 成果物（ER 図・スキーマ DDL）とレビュー完了条件
**Objective:** 開発チームとして、確定したデータモデルをレビュー済み成果物として残したい。それにより下流機能が確定済みの土台に依拠して着手できる。

#### Acceptance Criteria
1. The Data Model deliverable shall ER 図 と スキーマ DDL を含み、リポジトリに格納される.
2. The Data Model deliverable shall すべての階層・エンティティ（Requirement 1〜10 で定めた対象）と、その所属・整合性・書き込み境界を表現する.
3. When データモデルが最終化される, the Data Model deliverable shall 下流機能が依存を開始する前にレビューされ承認される.
4. If 成果物が本仕様の要件（階層整合性・匿名性・書き込み境界）のいずれかを満たさない, then the Data Model deliverable shall 未完了として扱われる.

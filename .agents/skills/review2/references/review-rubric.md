# Review rubric

レビュー候補を、高シグナルで再現可能なfindingへ変換するための共通基準。

## 目次

1. Finding成立条件
2. 観点と発火条件
3. Severity
4. Confidence
5. 指摘しないもの
6. Merge判断

## 1. Finding成立条件

次のすべてを満たすものだけを確定findingにする。

1. **PR attribution**: このPRが問題を導入、悪化、または既存の危険経路を新たに到達可能にした。
2. **Concrete scenario**: 現実的な入力、状態、順序、権限で失敗が起きる。
3. **Observable impact**: 誤結果、例外、データ損失、権限逸脱、互換性破壊、性能劣化などを説明できる。
4. **Evidence**: diff、呼び出し元、型、schema、テスト、実行結果のいずれかで主張を支えられる。
5. **Actionability**: 修正対象と最小の修正方向が分かる。
6. **Precise location**: 原則として問題を導入した変更行へ位置付けられる。
7. **Coverage integrity**: 対象fileのpatchが`complete`で、review snapshotのbase/head SHAと一致する。`partial`や古いsnapshotを確定根拠にしない。

「潜在的に危険」「best practiceではない」だけでは成立しない。前提が珍しい場合は、その前提とseverityへ反映する。

## 2. 観点と発火条件

### A. Correctness and data integrity

常に確認する。

- 境界値、null/empty、型変換、単位、timezone、locale、丸め
- success/errorの取り違え、例外の握り潰し、cleanup漏れ
- partial failure、retry、idempotency、重複処理
- transaction境界、整合性、不変条件、rollback
- 並行実行、順序依存、race、stale state、lost update
- 削除されたvalidation、guard、assertion、fallback、cleanup

### B. Security and privacy

auth、外部入力、秘密情報、ファイル、network、HTML/SQL/shell、権限境界に触るとき発火する。

- authenticationとauthorizationの混同、object-level authorization
- input validation、injection、path traversal、SSRF、XSS、unsafe deserialization
- secret/PIIのlog、error、analytics、client bundleへの漏洩
- CORS/CSRF/session/cookie、redirect、webhook署名
- dependency追加、supply-chain、危険なinstall script

脅威主体、入口、sink、既存control、到達経路を示せないsecurity findingは確定しない。

既存controlを「あるはず」と仮定しない一方、diffだけで「無い」とも断定しない。sourceからsinkまでのcontrolを取得し、支持証拠と反証を分ける。

### C. Compatibility, schema, and migrations

public API、DB、event、file format、CLI、SDK、configに触るとき発火する。

- old/new versionの同時稼働、rolling deploy、rollback
- required field追加、rename/delete、型縮小、enum変更、default
- migrationのlock、table rewrite、backfill、index、順序、再実行
- producer/consumerのdeploy順、generated artifact drift
- deprecated経路と移行期間

### D. Regression and blast radius

共有module、state、component、middleware、schema、utilityに触るとき発火する。

- 直接のcallerと間接consumer
- 同一部品が複数箇所で同時に実体化するときの識別子（DOM id、key、cache/lockキー）衝突や共有stateの相互干渉
- feature flag、tenant、role、platform、browser、locale分岐
- cache、polling、retry、event ordering
- default変更、config precedence、fallbackの消失
- failure時だけ通る経路

### E. Performance and resource use

hot path、loop、query、render、serialization、I/O、cacheに触るとき発火する。

- N+1、unbounded work、全件load、quadratic behavior
- blocking I/O、connection/file/goroutine/task leak
- cache invalidation、stampede、large payload、bundle regression
- rerender、layout thrash、main-thread blocking

小さな差を根拠なく断定しない。入力規模と悪化の次数、または測定結果を示す。

### F. Test quality and verification

behavior変更には常に発火する。

- 新しい分岐、境界値、異常系、permission分岐のcoverage
- assertionが実際の振る舞いを検証しているか
- mockが実装を写経していないか、重要integrationを隠していないか
- flaky要因、clock/random/network/order/shared state
- regression testが修正前に失敗し修正後に通る形か
- 実行時障害（クラッシュ・データ破損）の修正に、その再発（オプション欠落・guard削除）を検出するテストが伴うか。障害の記録が具体的なら「テストがない」でも成立する
- mockの固定値・恒等値がPRの新挙動を打ち消し、テストが新挙動でなく「エラーにならないこと」しか検証していないか
- 0件実行、全skip、cache hit、対象外filterを成功と誤認していないか

「テストがない」だけでfindingにしない。未テストの具体的な回帰リスクと、追加すべきscenarioを示す。

### G. Operations and observability

runtime service、job、deploy、config、error handlingに触るとき発火する。

- actionable log/metric/trace、request correlation、PII回避
- timeout、retry、circuit breaker、backpressure
- rollout、rollback、feature flag、migration順序
- alertとrunbook、silent failure、partial outage

### H. Intent, documentation, and UX

PR本文、Issue、仕様、public docs、UIに触るとき発火する。

- acceptance criteriaの未達、scope逸脱、仕様と実装の矛盾
- public behaviorに対するdocs/example/changelogのdrift
- accessibility、keyboard、focus、label、error feedback
- destructive actionの確認、loading/empty/error状態

文言の好みやstylingは、機能・アクセシビリティ・誤操作へ影響しない限りNit以下とする。

## 3. Severity

| Level | 基準 | Mergeへの影響 |
|---|---|---|
| High | 高確度のデータ損失、セキュリティ侵害、主要機能破壊、重大な互換性破壊、必須check失敗 | 原則ブロック |
| Middle | 現実的な条件で起きるバグ、回帰、運用障害、重要なテスト欠落 | merge前に修正または明示的受容 |
| Low | 影響が限定的なedge case、小さな性能/保守性問題 | 非ブロック、既定では投稿しない |
| Nit | style、命名、好み、任意の整理 | サマリーにも原則不要 |

severityはコードの見た目ではなく、影響、発生可能性、検出可能性、回復容易性で決める。重大そうでも到達性が未確定ならconfidenceを下げ、`REVIEW`へ回す。

severityとconfidenceを混同しない。稀だが破壊的なscenarioは影響と発生可能性を明示してseverityを決め、証拠不足はconfidenceへ反映する。inline本文にはseverityだけを載せ、confidenceとproof gapは内部記録またはチャットサマリーへ残す。

## 4. Confidence

| Level | 根拠 |
|---|---|
| high | 実行で再現した、またはコード経路と前提が決定的 |
| medium | 静的証拠は強いが環境・入力条件の一部が未確認 |
| low | 仕様、deployment、runtime情報が不足し、仮説の域を出ない |

既定のinline投稿はhigh/medium confidenceのHigh/Middleだけとする。low confidenceは`REVIEW`としてcoverage gapまたは要確認へ分離する。

内部findingは`evidence_for`、`evidence_against`、`unverified_assumptions`、`proof_gaps`を分離する。反証を試していない候補をhigh confidenceにしない。

## 5. 指摘しないもの

- PRが触れていない既存問題
- formatter、lint、type checkerが自動的に扱うstyleだけの問題
- 根拠のない「将来困るかもしれない」
- 具体的な失敗を伴わない抽象化、命名、設計の好み
- intentional changeを「既存挙動と違う」という理由だけで問題扱いすること
- test、type、guard、caller contractですでに防止される経路
- generated/vendor/binaryの内容を手書きsourceと同じように行レビューすること
- PRのscope外にある大規模な書き直し

## 6. Merge判断

- findingsがゼロでも、重要な未検証領域が変更範囲と重なるならLGTMにしない。
- `partial`/`missing` diff、未担当high-risk path、snapshot不一致があればLGTMにしない。
- CIが赤でも、PRと無関係な既知障害なら自動的にHighへしない。根拠を分ける。
- E2E未実施は、それ自体をfindingにしない。UI/runtime riskが主要変更で代替証拠が無い場合だけ条件にする。
- 動的に観測した問題は、同じscenarioのbase/head比較でPR帰属を確認する。baseでも失敗するなら原則としてPR findingにしない。
- Highが1件でもあればMerge非推奨。Middleだけなら条件付き。High/Middleなしで意図と検証が十分ならLGTM。

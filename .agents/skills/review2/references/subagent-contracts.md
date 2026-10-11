# Independent review contracts

利用可能なsubagentで探索と反証を分離するときの契約。subagent機能がない場合は、親が同じ契約で独立した直列パスを行う。

## 目次

1. 共通入力
2. 探索契約
3. 反証契約
4. 集約契約
5. 縮退ルール

## 1. 共通入力

各reviewerへ必要最小限の同一事実を渡す。

- PR title/bodyと受け入れ条件
- base/head SHA
- review profileのうち担当範囲に必要なルール、domain invariant、検証コマンド
- 担当するdiff。回帰担当にはchange mapと関連consumerを追加する
- 担当pathのdiffmap
- coverage ledgerの担当行とrisk
- 親が実行済みのCI/build/test結果
- [review-rubric.md](review-rubric.md) のfinding成立条件、severity、confidence

親の結論、期待するfinding、別reviewerの候補を探索担当へ漏らさない。独立性を守る。

subagentへ次の安全条件を明示する。

- read-only分析だけを行う
- checkout、worktree作成、install、build、test、PR投稿を行わない
- secretsや`.env`の値を読まない
- diff外の既存問題をfindingにしない
- 存在しないツールやプロジェクト前提を推測しない

## 2. 探索契約

小さなPRは親の3パスで十分である。大きいPR、複数stack、security/schema変更、high effortでは、独立reviewerへ分ける。

推奨グループ:

1. correctness + intent + data integrity
2. security + privacy + dependency
3. compatibility + migration + regression
4. tests + operations + performance + docs/UX

変更がない観点のreviewerは起動しない。巨大diffはpathまたはcomponentでshardし、回帰担当だけchange map全体を持つ。

### 探索prompt

```text
担当観点だけでPR差分をレビューしてください。
review-rubricのFinding成立条件をすべて満たす候補だけを返してください。
既知パターンへの当てはめより、変更した不変条件・データフロー・境界を第一原理で追ってください。
変更行でない既存問題、style、根拠のない可能性は返さないでください。
line番号は推測せず、変更行の原文をcode_anchorにしてください。
削除が原因ならside=LEFT、追加が原因ならside=RIGHTを返してください。context行だけをanchorにしないでください。
各候補に成立条件、具体的影響、反証可能な証拠、最小修正を含めてください。
GitHubへ載せる最終コメント文は書かず、構造化した事実だけを返してください。
候補がなければfindingsを空配列にしてください。
最終出力はJSONコードフェンス1つだけにしてください。
```

### 探索出力

```json
{
  "findings": [
    {
      "path": "src/example.ts",
      "code_anchor": "変更行と必要最小限の周辺行",
      "side": "LEFT|RIGHT",
      "category": "correctness|security|compatibility|regression|performance|tests|operations|intent|docs|ux",
      "claim": "具体的に何が壊れるか",
      "preconditions": ["成立条件"],
      "impact": "観測される影響",
      "evidence_for": ["diff、caller、型、schema、テスト結果"],
      "evidence_against": ["既存guardや反例"],
      "unverified_assumptions": ["未確認の前提"],
      "suggested_fix": "最小の修正方針",
      "provisional_severity": "High|Middle|Low|Nit",
      "confidence": "high|medium|low"
    }
  ]
}
```

必須key欠落、JSON parse失敗、`code_anchor`不在は1回だけ再依頼する。再失敗はcoverage gapへ記録する。

## 3. 反証契約

反証担当には、元reviewerのseverity、断定的なclaim、修正案を見せない。anchoringを避けるため、容疑を`Given / When / Observed behavior`の中立命題へ変換して渡す。

渡すもの:

- path、code anchor、side、周辺diff
- preconditions
- 中立命題: `Given <前提> / When <操作> / Observed <容疑となる結果>`
- diffmapの該当path
- PR intentとreview profileの関連部分

元reviewerが集めた支持証拠を正解として渡さない。critic自身にcaller、guard、type、schema、testをread-onlyで再取得させる。

### 反証prompt

```text
以下は未確定の容疑です。支持するのでなく、まず反証してください。

1. このPRの追加・変更が原因か。
2. 前提は現実的で、経路へ到達できるか。
3. 型、validation、認可、transaction、caller、既存testで防がれていないか。
4. 観測可能な影響があるか。
5. 指摘位置は問題を導入した変更行か。
6. base snapshotでも同じ挙動ではないか。

各容疑をKEEP、DOWNGRADE、REJECT、REVIEWのいずれかに分類してください。
KEEPには具体的な再現シナリオと最も強い証拠を付けてください。
REJECTには反証した事実を付けてください。
重要だが仕様・環境が不足する場合だけREVIEWにしてください。
支持証拠、反証、未確認前提を別々に返してください。
最終出力はJSONコードフェンス1つだけにしてください。
```

### 反証出力

```json
{
  "verdicts": [
    {
      "anchor_ref": "path + code_anchor先頭",
      "verdict": "KEEP|DOWNGRADE|REJECT|REVIEW",
      "reason": "判定を支える事実",
      "repro": "KEEPの場合の具体的シナリオ",
      "evidence_for": ["独立に取得した支持証拠"],
      "evidence_against": ["独立に取得した反証"],
      "unverified_assumptions": ["未確認の前提"],
      "recommended_severity": "High|Middle|Low|Nit|null",
      "confidence": "high|medium|low"
    }
  ]
}
```

## 4. 集約契約

親が一元的に行う。

1. `(path, overlap)`かつ意味的に同じ候補だけをdeduplicateする。
2. `code_anchor`を同じpath、同じsideのdiffmap textへ照合する。複数一致は周辺行で一意化する。
3. 一意化できない静的findingはinline候補から外し、coverage gapへ回す。
4. `KEEP`をPR全体のimpactとlikelihoodで再評価し、severityとconfidenceを確定する。
5. `DOWNGRADE`を受理する場合は推奨severityで再評価し、確定した最終findingを`verdict=KEEP`として新規作成する。元の`DOWNGRADE`は監査用に保持する。
6. `REJECT`と`REVIEW`は監査用に保持し、投稿payloadへ渡さない。
7. 観点境界の複合問題を親が1回再走査する。
8. high effortでは、確定findingを見せずに全diffを別パスで再走査し、false negativeを探す。
9. 全shardの完了をcoverage ledgerへ反映し、未返却担当を成功扱いしない。

並列reviewerの多数決で真偽を決めない。1件の強い証拠は、複数の弱い同意より優先する。

## 5. 縮退ルール

subagentが利用不能、入力上限、parse失敗、timeoutの場合:

- 親が同じrubricで直列パスを行う
- 読めなかったpathや実行できなかった観点を列挙する
- 変更の主要リスクと縮退範囲が重なる場合はLGTMを出さない
- 縮退を隠すためにconfidenceを上げない

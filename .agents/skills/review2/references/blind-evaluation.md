# Blind review evaluation

PRレビューSkillの見逃し、誤検知、severity判定を、ground truthをreviewerへ漏らさず継続測定する。
評価結果を、同じcorpus、Skill、scorer、model、tool policyへ束縛し、再現不能な数値をbaselineにしない。

## 目次

1. 評価原則
2. 評価資産の物理分離
3. Corpusとoracle
4. Public pack
5. Live runとreplicate
6. Prediction契約
7. Strict matching
8. Metrics
9. Digestと再現性
10. Baselineとhistory
11. Regression gate
12. CIとcredential境界
13. JSON report
14. 推奨コマンド
15. 完了条件

## 1. 評価原則

次を必須条件として扱う。

- reviewerへ期待finding、severity、case tag、mutation名、過去のpredictionを渡さない。
- freshなreviewerがpublic artifactだけからfindingを再構築できるか測る。
- precision、recall、severityを同時に測り、1指標だけを最適化しない。
- 同じpredictionを同じscorerへ入力すれば同じreportを返す。
- live実行と保存済みpredictionのreplayを区別する。
- timeout、JSON不正、部分出力、未実行caseを黙って母数から除外しない。
- 複数reviewerの多数決をground truthの代わりにしない。
- modelによる自由形式の再採点を必須gateに使わない。

## 2. 評価資産の物理分離

public packとoracleを、命名上だけでなく物理的に分離する。

```text
<EVAL_CONTROL_ROOT>/
├── corpus.json
├── policy.json
├── public-source/
├── baselines/
└── history/

<ORACLE_ROOT>/                 # reviewer workspace外、別mountまたは別storage
└── <corpus-version>/
    └── <neutral-case-id>.json

<FRESH_REVIEW_ROOT>/           # runごとに新規作成
├── skill/
└── case/
```

次を守る。

- `ORACLE_ROOT`をSkill directory、repository、public pack、reviewer workspaceの配下へ置かない。
- live reviewer processまたはcontainerへ`ORACLE_ROOT`をmountしない。
- reviewerへ渡すSkill copyへoracle、baseline、history、前回reportを含めない。
- host全体を読める実行環境をblind runとして認定しない。
- public packだけをread-only mountし、output directoryだけを書き込み可能にする。
- network、secrets、GitHub token、cloud credentialを既定で渡さない。
- public pack内のsymlink、hardlink、absolute path、`..`を使うarchive entryを拒否する。
- runごとに`FRESH_REVIEW_ROOT`を新規作成し、終了後にreviewer artifactを隔離してから撤去する。
- reviewerへ`EVAL_CONTROL_ROOT`や`ORACLE_ROOT`のpathをpromptで知らせない。

local control planeで`evals/pr-review-e2e/oracle/`を保持する場合は、そのrootを公開repositoryへ含めず、
packをworkspace外へ作成し、reviewer subprocessからworkspace root全体をOS sandboxでread-denyする。
`--isolation-mode verified`は、この外部denyを`run --deny-read-root`で強制できる場合だけ使う。

同じhost上で強いfilesystem隔離を作れない場合は、そのrunを`blind=false`として記録し、release gateへ使わない。

## 3. Corpusとoracle

case IDにはUUIDまたは無意味な連番を使う。
`auth-bypass-high`、`missing-validation`のように答えを含む名前を使わない。

public側には、実際のレビューに必要な情報だけを置く。

- base/head snapshotまたは再構築可能なrepository artifact
- PR title、body、変更file、diff、checksなどの入力
- base snapshotのproject rules
- 実行を許可するtool policy

oracle側だけに次を置く。

```json
{
  "schema_version": 1,
  "case_id": "case-019",
  "snapshot_digest": "sha256:...",
  "findings": [
    {
      "oracle_id": "O-019-1",
      "path": "src/service.ts",
      "side": "LEFT",
      "line_ranges": [[41, 43]],
      "category": "security",
      "failure_modes": ["authorization_bypass", "tenant_escape"],
      "severity": "High",
      "must_detect": true
    }
  ]
}
```

oracleを独立した2名以上で作成または確認し、相違をadjudicateする。
既存bug、intentional change、clean PRをnegative caseとして含める。
High、Middle、LEFT削除、RIGHT追加、権限、migration、並行性、partial failure、test false successを偏りなく含める。

released corpusを直接書き換えない。
scoring意味論を変える場合はmajor、caseまたはgoldを追加・変更する場合はminor、結果を変えないmetadata修正だけをpatchとしてversionを上げる。
version表記に加えて、content digestをreportの正本とする。

## 4. Public pack

`pack`でcaseごとのreviewer入力を作る。

- neutral case ID以外のprivate tagを除去する。
- oracle key、expected severity、oracle ID、mutation名を含めない。
- commit messageやfixture名にも答えを含めない。
- repository snapshotとPR metadataのdigestを固定する。
- Skill copyから評価用oracle、baseline、historyを除外する。
- pack manifestへ許可fileとdigestだけを列挙する。
- pack作成後にarchive traversal、symlink、禁止key、予期しないfileを検査する。

`validate`でpublic packとoracleのcase集合が一致することはcontrol plane側で確認してよい。
その照合結果やoracle pathをreviewerへ渡さない。

## 5. Live runとreplicate

同一candidateを、caseごとに最低3 replicateのfresh sessionで実行する。

- replicateごとに新しいworkspace、session、output fileを使う。
- 前replicateのchat、finding、cache、temporary fileを引き継がない。
- 同じpublic pack、Skill digest、model profile、tool policyを使う。
- seedをruntimeが実際に固定できる場合だけ`seed_effective=true`とする。
- seedを固定できない場合はfresh replicateとして記録し、架空のseed再現性を主張しない。
- timeoutやruntime failureを再試行する場合は、元runをhistoryへ残し、再試行を別run IDにする。
- candidateとbaselineを比較するときは、同じcase、replicate schedule、model、tool policyでpaired実行する。

`execution_mode=live`はreviewerを新規実行したreportだけに付ける。
保存済みpredictionを再採点した場合は`execution_mode=replay`とする。
replayをfresh model評価として報告しない。

## 6. Prediction契約

reviewerの最終出力を構造化JSONへ限定する。

```json
{
  "schema_version": 1,
  "case_id": "case-019",
  "review_snapshot_digest": "sha256:...",
  "findings": [
    {
      "path": "src/service.ts",
      "side": "LEFT",
      "line": 42,
      "category": "security",
      "failure_mode": "authorization_bypass",
      "severity": "High",
      "confidence": "high",
      "claim": "具体的な失敗と影響"
    }
  ]
}
```

oracle IDや期待severityの入力を要求しない。
レビューで確定したHigh/Middleだけをprimary scoreへ渡す。
Low、Nit、REVIEW、coverage gapは別fieldへ保存してよいが、High/Middleを検出した扱いにしない。
JSON不正、case ID不一致、snapshot不一致はinvalid runとし、成功caseだけへ縮めて採点しない。

## 7. Strict matching

predictionとoracleを、case内でstrict one-to-one matchingする。

候補pairを次のすべてが一致する場合だけ作る。

1. repository-relative `path`が完全一致する。
2. `side`が一致する。
3. predictionの`line`がoracleの許容`line_ranges`内にある。
4. `category`が一致する。
5. `failure_mode`がoracleの許容値に一致する。

最大cardinalityの決定論的matchingを行い、1 predictionを複数oracleへ、1 oracleを複数predictionへ使わない。
同じ根本原因の重複predictionは、最初の1件だけをmatchし、余剰をfalse positiveにする。
複数の最大matchingが異なるscoreを生むoracle設計を`validate`で拒否する。

自由文の類似度だけでmatchしない。
自動matchingできない新規failure modeは`adjudication_required`へ分離し、現在のgateを都合よく書き換えない。
人手adjudication後はoracleとcorpus versionを更新し、baselineを新corpus上で再実行する。

## 8. Metrics

raw countと比率を両方保存する。

- `pooled_high_middle`: severityを問わず、material findingを検出したprecision、recall、F1
- `high`: oracleとpredictionがともにHighの場合だけTPとするprecision、recall、F1
- `middle`: oracleとpredictionがともにMiddleの場合だけTPとするprecision、recall、F1
- `severity_agreement`: matchしたHigh/Middleのうちseverityが完全一致した割合
- `severity_confusion`: `oracle High -> predicted Middle`などのconfusion matrix
- `negative_fp_rate`: negative caseのうち1件以上High/Middleを出した割合
- `negative_fp_per_pr`: negative case 1件当たりのHigh/Middle FP数
- `must_detect_recall`: `must_detect=true`の検出率
- `invalid_output_rate`: JSON不正、snapshot不一致、timeoutの割合
- `case_coverage`: 予定case/replicateのうち有効に完了した割合

HighをMiddleと予測したmatchは、pooledではTP、HighではFN、MiddleではFP、severity agreementでは不一致とする。
MiddleをHighと予測した場合も対称に扱う。
zero denominatorを`1.0`にせず`0.0`とし、truth supportをraw countで併記する。
policyの最低母数に満たないgateは`pass`にせずfailまたは`insufficient`にする。

replicate全体のpooled countに加え、run平均、標準偏差、worst replicate、oracle findingごとのmiss rateを出す。
平均値だけで特定replicateやreviewer profileの失敗を隠さない。

## 9. Digestと再現性

各reportへ最低限、次のSHA-256 digestを記録する。

- corpus manifestとpublic packの`corpus_digest`
- candidate Skill treeの`skill_digest`
- scorer sourceとschemaの`scorer_digest`
- model名、snapshot、reasoning設定を正規化した`model_digest`
- 利用可能tool、network、filesystem、実行許可を正規化した`tool_policy_digest`
- reviewer promptの`prompt_digest`

digest対象の正規化規則をscorer versionへ固定する。
いずれかのdigestが欠落するreportをbaseline候補にしない。
corpus、scorer、model、tool policyが異なるreportを、互換性確認なしに直接比較しない。

## 10. Baselineとhistory

baselineを自動更新しない。

- baseline昇格には人手承認、全gate成功、互換digest一致を要求する。
- candidateがbaselineを上回っても自動promoteしない。
- corpusを変更したら、旧baseline数値を流用せず、baseline Skillとcandidate Skillを新corpus上でpaired再実行する。
- model snapshotを固定できない場合も、baselineとcandidateを同じ時間帯にpaired実行する。
- baselineへSkill commit SHAまたはimmutable artifact digestを記録する。
- baseline fileの更新を通常のscore commandから分離する。

historyをimmutableに保存する。

- `<date>/<run-id>.json`の新規fileとしてrecordする。
- 既存run IDを上書きしない。
- raw prediction、aggregate report、comparison resultのdigestを相互参照する。
- 失敗run、invalid run、再試行前runも消さない。
- baseline昇格の承認者、時刻、source run IDを監査情報として残す。

## 11. Regression gate

absolute floorとbaseline deltaの両方を適用する。

推奨する初期floor:

```json
{
  "absolute_floors": {
    "pooled_precision": 0.90,
    "pooled_recall": 0.85,
    "high_precision": 0.90,
    "high_recall": 0.90,
    "middle_precision": 0.85,
    "middle_recall": 0.80,
    "severity_agreement": 0.85,
    "must_detect_recall": 1.0,
    "case_coverage": 1.0,
    "invalid_output_rate": 0.0
  },
  "max_regression": {
    "pooled_precision": 0.02,
    "high_recall": 0.00,
    "middle_recall": 0.03,
    "severity_agreement": 0.03,
    "negative_fp_per_pr": 0.0
  }
}
```

次の場合はfailする。

- absolute floorを1つでも下回る。
- baselineから許容幅を超えて悪化する。
- `must_detect`を1 replicateでも見逃す。
- negative caseのFPがbaselineから増える。
- invalid output、case欠落、digest不一致がある。
- required reviewer profileの失敗を他profileとの平均で隠している。

母数がpolicyの最低件数に達しない場合は`pass`でなく`insufficient`を返す。
thresholdをcandidate結果を見た後で変更しない。
policy変更はversionを上げ、baselineとcandidateを新policyで再採点する。

## 12. CIとcredential境界

通常のfork PR CIでは、次だけを実行する。

- corpus、public pack、oracle、prediction、report schemaのcontrol-plane validation
- public packへのoracle漏洩、禁止path、symlinkの検査
- scorer unit test
- 保存済みpredictionのreplay score
- baseline互換性とdigest検証
- candidate reportに対するregression gate

model API key、GitHub write token、cloud credential、private holdout credentialをfork PRへ渡さない。
fork PRのコードをcredential付きworkflow runnerとして実行しない。

live model evaluationはtrusted manual、scheduled、またはbase branch管理のworkflowから実行する。
対象PRはread-only artifactとして取得し、runner codeとcredential policyはtrusted base側を使う。
通常CIは、trusted live runが出したreportのcandidate Skill digestと現在の変更が一致することだけを検証する。

replay CIが成功しても、candidate Skill変更後のfresh review精度を測定したことにはしない。

## 13. JSON report

aggregate reportへ最低限、次を含める。

```json
{
  "schema_version": 1,
  "run_id": "run-...",
  "execution_mode": "live",
  "blind": true,
  "digests": {
    "corpus": "sha256:...",
    "skill": "sha256:...",
    "scorer": "sha256:...",
    "model": "sha256:...",
    "tool_policy": "sha256:...",
    "prompt": "sha256:..."
  },
  "replicates": 3,
  "counts": {
    "pooled_high_middle": {"tp": 0, "fp": 0, "fn": 0},
    "high": {"tp": 0, "fp": 0, "fn": 0},
    "middle": {"tp": 0, "fp": 0, "fn": 0}
  },
  "metrics": {
    "pooled_high_middle": {"precision": null, "recall": null, "f1": null},
    "high": {"precision": null, "recall": null, "f1": null},
    "middle": {"precision": null, "recall": null, "f1": null},
    "severity_agreement": null,
    "severity_confusion": {},
    "negative_fp_rate": null,
    "negative_fp_per_pr": null
  },
  "comparison": {
    "baseline_run_id": null,
    "deltas": {}
  },
  "gate": {
    "status": "pass|fail|insufficient",
    "violations": []
  }
}
```

case別・replicate別のraw count、invalid理由、除外理由、matching結果を監査用detailへ含める。
post-hoc exclusionを禁止し、事前にpolicyで除外したcaseだけをreportへ明記する。

## 14. 推奨コマンド

同じ`review_eval.py`へ決定論的control planeを集約する。

```bash
EVAL=skills/pr-review-e2e/scripts/review_eval.py
ROOT=evals/pr-review-e2e

python3 "$EVAL" validate \
  --cases "$ROOT/public/cases.json" \
  --truth "$ROOT/oracle/ground-truth.json" \
  --taxonomy "$ROOT/issue-taxonomy.json" \
  --prediction-schema "$ROOT/prediction.schema.json"

python3 "$EVAL" pack \
  --cases "$ROOT/public/cases.json" \
  --taxonomy "$ROOT/issue-taxonomy.json" \
  --prediction-schema "$ROOT/prediction.schema.json" \
  --prompt "$ROOT/reviewer-prompt.md" --skill-root skills/pr-review-e2e \
  --run-id <RUN_ID> --replicate-id <N> --shuffle-seed <SEED> \
  --reviewer-name <NAME> --model <MODEL> --model-version <VERSION> \
  --reasoning-effort <EFFORT> --isolation-mode verified --output <PUBLIC_PACK>

python3 "$EVAL" run --pack <PUBLIC_PACK> --output <PREDICTIONS> \
  --codex-bin <CODEX_BIN> --deny-read-root <WORKSPACE_ROOT>

python3 "$EVAL" score --pack <PUBLIC_PACK> \
  --truth "$ROOT/oracle/ground-truth.json" \
  --predictions <PREDICTIONS> --output <SCORE_REPORT>

python3 "$EVAL" aggregate \
  --score <SCORE_1> --score <SCORE_2> --score <SCORE_3> \
  --measurement-id <MEASUREMENT_ID> --output <AGGREGATE_REPORT.json>

python3 "$EVAL" compare --candidate <AGGREGATE_REPORT.json> \
  --baseline <BASELINE_REPORT.json> --policy "$ROOT/policy.json" \
  --output <COMPARISON_REPORT.json>

python3 "$EVAL" record --aggregate <AGGREGATE_REPORT.json> \
  --history "$ROOT/history.jsonl"
```

`run`だけをmodel/runtime依存adapterとして実装し、`validate`、`pack`、`score`、`aggregate`、`compare`、`record`を決定論的にする。
`record`は既存run IDが存在する場合にfailし、上書きoptionを設けない。

## 15. 完了条件

- [ ] public packとoracleがreviewerから到達不能な別rootにある。
- [ ] 全caseがneutral IDを使う。
- [ ] 各caseをfresh workspaceで3 replicate実行する。
- [ ] liveとreplayがreportで区別される。
- [ ] corpus、Skill、scorer、model、tool policy、prompt digestが記録される。
- [ ] strict one-to-one matchingが決定論的に再現する。
- [ ] pooled、High、Middle、severity agreement、confusion、negative FPを算出する。
- [ ] baselineが自動更新されない。
- [ ] historyがimmutableで、失敗runも残る。
- [ ] absolute floorとbaseline deltaを両方検査する。
- [ ] fork PRへmodel credentialを渡さない。
- [ ] 同じpredictionのreplayがbyte-equivalentなmetricsを返す。

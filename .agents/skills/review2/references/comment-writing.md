# Review comment writing

確定findingの完全な証拠は構造化データに保持し、GitHub inline commentには修正判断に必要な最小情報だけを投影する。

## 目次

1. 本文の契約
2. Severityとconfidence
3. 禁止する表現と構造
4. 良い例と悪い例
5. 機械検査
6. 過度な短縮を避ける
7. Payload生成

## 1. 本文の契約

1コメントでは1つの根本原因だけを扱う。別の原因や別の修正が必要ならコメントを分ける。

原則として次の2文で書く。

```text
**[Severity]** <成立条件と具体的な不具合・影響>。<満たすべき最小の修正条件>。
```

- 第1文で、必要なら成立条件を先に置き、具体的に何が壊れてどの影響が出るかを書く。
- 第2文で、特定の実装を強制しすぎず、満たすべき最小の修正条件を書く。
- 原則2文、最大2文とする。補足証拠はチャットのレビューサマリーへ置く。
- prefixを含む本文は60〜180文字を推奨し、240文字をhard maxとする。
- inline位置から自明なpathや行番号を本文で繰り返さない。
- `ここ`、`これ`、`それ`ではなく、関数名、field名、状態、入力条件を示す。
- 問題を再現できない一般論や、修正結果を判定できない依頼を書かない。

- 修正案が複数ある場合はpatchを指定せず、`更新前にresource ownerとsession userの一致を保証する`のように不変条件を示す。

## 2. Severityとconfidence

- GitHub inlineには `**[High]**` または `**[Middle]**` のseverityだけを表示する。
- confidenceは構造化findingと投稿前のチャットサマリーに保持し、inline本文へ表示しない。
- 既定のinline候補は、反証結果が `verdict=KEEP`、severityがHigh/Middle、confidenceがhigh/mediumのfindingに限る。
- `DOWNGRADE`、`REJECT`、`REVIEW`はpayloadへ含めない。
- low confidenceは断定的なfindingにせず、`REVIEW`またはcoverage gapへ移す。
- medium confidenceでも曖昧語で濁さず、主張が成立する条件を明記する。
- Low/Nitは既定で投稿せず、ユーザーが明示した場合だけ別途扱う。

severityは影響の大きさ、confidenceは証拠の強さである。文章を強く書くことでseverityを上げたり、弱く書くことで不確実性を隠したりしない。

## 3. 禁止する表現と構造

次をinline本文へ含めない。

- `問題があります`、`危険です`、`可能性があります`、`かもしれません`だけで済ませる曖昧な主張
- `適切に修正してください`、`対応してください`、`検討してください`だけで済ませる修正依頼
- `あなた`、`作者`、`実装者`、`なぜこの実装にした`など、人を評価または非難する表現
- `気になります`、`念のため`、`ベストプラクティスです`など、具体的な失敗を示さない一般論
- 疑問文、反語、感嘆符
- Markdownの見出し、箇条書き、表、長いcode block
- 複数段落、改行を含む散文

レビュー対象は人ではなくコードと観測可能な挙動である。質問しなければ確定できない事項は、findingへ偽装せず投稿前サマリーの要確認事項へ分離する。

## 4. 良い例と悪い例

### 認可

```text
悪い: **[High]** セキュリティ上問題になる可能性があります。適切に修正してください。
良い: **[High]** 他ユーザーのIDを指定すると所有者確認なしで更新でき、データを改ざんできます。更新前に`resource.ownerId`と`session.userId`を照合してください。
```

### response処理

```text
悪い: **[Middle]** 204で落ちます。修正してください。
良い: **[Middle]** APIが204を返すと`response.json()`が失敗し、保存成功後もエラー表示になります。204ではbodyを読まず成功として処理してください。
```

### テスト

```text
悪い: **[Middle]** テストを追加してください。カバレッジが足りません。
良い: **[Middle]** 権限のないユーザーの更新経路が未検証なため、認可条件の削除を検出できません。403を期待する回帰テストを追加してください。
```

### 並行処理

```text
悪い: **[High]** レースコンディションになる可能性があります。見直してください。
良い: **[Middle]** 2つのworkerが同じ未処理行を取得すると、同じ請求を二重送信します。取得と処理済み更新を同じ排他処理へ入れてください。
```

## 5. 機械検査

投稿payloadの生成前に、同梱の `scripts/prepare_review_payload.py` で次を検査する。

- verdict、severity、confidenceが許可された値か
- verdictが `KEEP` のfindingだけを採用しているか
- problemとfixがそれぞれ1文か
- 改行、疑問文、感嘆符、曖昧語、人への言及、Markdown block構造がないか
- render後の本文が240文字以内か
- 60文字未満または180文字超ならwarningを出す
- line、side、start_line、start_sideがGitHub review commentとして整合するか
- diffmap schema v2、head SHA、`patch_state=complete`、changed line、同一hunkへ一致するか

構文lintを通っても意味は保証されない。投稿前に、成立条件、観測可能な影響、最小修正が具体的であることを人または独立criticが確認する。

## 6. 過度な短縮を避ける

短さ自体を目的にしない。成立条件を削ると誤検知に見え、影響を削るとseverityの理由が消え、修正条件を削ると往復が増える。識別子や不確実性まで削って仮説を断定へ変えてはいけない。

削る対象は、重複するpath、一般論、長い背景、証拠の列挙である。残す対象は、条件、失敗、影響、最小修正である。

## 7. Payload生成

次の構造化JSONを入力する。`problem`と`fix`には終端記号を含む1文をそれぞれ指定する。

```json
{
  "event": "COMMENT",
  "commit_id": "<HEAD_SHA>",
  "review_body": "High 1件を確認しました。",
  "findings": [
    {
      "path": "src/example.ts",
      "line": 42,
      "side": "RIGHT",
      "verdict": "KEEP",
      "severity": "High",
      "confidence": "high",
      "problem": "別ユーザーのIDを指定すると所有者確認なしで更新できます。",
      "fix": "更新前にresource ownerとsession userを照合してください。"
    }
  ]
}
```

複数行commentでは `start_line` と `start_side` を追加する。削除側は `LEFT`、追加側は `RIGHT`を使い、同じcommentでsideをまたがない。

```bash
python3 scripts/prepare_review_payload.py \
  --input /tmp/pr-findings.json \
  --diffmap /tmp/pr-diffmap.json \
  --output /tmp/pr-review-payload.json
```

`APPROVE`または`REQUEST_CHANGES`は、ユーザーの明示承認後に `--allow-decision-event`を付けた場合だけ生成する。`APPROVE`は`findings=[]`、diffmapの完全coverage、`merge_decision=lgtm`、`required_checks=passed|not-applicable`、`intent_status=satisfied`をすべて要求する。`REQUEST_CHANGES`は`merge_decision=block`と少なくとも1件の投稿可能なHigh/Middle inline findingを要求する。出力JSONはそのままGitHub reviews APIのpayloadとして使える。

LowまたはNitをユーザーが明示的に投稿対象へ含めた場合だけ、`--include-severity Low`または`--include-severity Nit`を追加する。`REVIEW`、`DOWNGRADE`、`REJECT`は常に除外する。

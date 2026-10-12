# GitHub inline review

PR差分を正規化し、ユーザー承認後にだけ安全にinline reviewを投稿する。

## 目次

1. Metadataとfiles取得
2. Diffmap生成
3. Anchor解決
4. 投稿前ゲート
5. Payloadと投稿
6. 失敗時の扱い

## 1. Metadataとfiles取得

owner/repoを明示し、カレントディレクトリへの依存を避ける。

```bash
gh pr view <PR> --repo <OWNER/REPO> \
  --json number,title,url,body,baseRefName,baseRefOid,headRefName,headRefOid,changedFiles,files
gh api --paginate --slurp \
  "repos/<OWNER>/<REPO>/pulls/<PR>/files?per_page=100" \
  > /tmp/pr-<PR>-files.json
git -C <VALIDATED_ROOT> merge-base <BASE_SHA> <HEAD_SHA>
```

`--paginate`なしではファイルが欠落する。`--slurp`でpage配列を1つのJSONへまとめる。取得件数とmetadataの`changedFiles`を照合する。Pull Request files APIは最大3,000ファイルなので、`changedFiles > 3000`または取得件数が一致しない場合はローカルdiffで補完し、完全取得したと誤認しない。

base/head SHA、merge-base、検証対象SHAをすべてのreview artifactへ保存する。取得後にもbase/head SHAを再確認し、変化していたら古いartifactを破棄する。PR更新後に古い行へ投稿しない。

## 2. Diffmap生成

同梱scriptを使う。

```bash
python3 scripts/build_diffmap.py \
  --input /tmp/pr-<PR>-files.json \
  --base-sha <BASE_SHA> \
  --merge-base-sha <MERGE_BASE_SHA> \
  --head-sha <HEAD_SHA> \
  --expected-file-count <CHANGED_FILES> \
  --output /tmp/pr-<PR>-diffmap.json
```

リポジトリルールでgenerated/vendor/build pathが明示される場合だけ、repeatableな`--exclude`を追加する。

```bash
python3 scripts/build_diffmap.py ... \
  --exclude 'vendor/**' \
  --exclude '**/generated/**'
```

scriptは次を保持する。

- `base_sha`、`merge_base_sha`、`head_sha`、expected/received file count
- 新pathとrename前path
- file status、additions、deletions
- `LEFT`削除行と`RIGHT`追加・context行ごとの`text`、`op`、`is_changed`、`reviewable`、old/new line
- API件数とparsed additions/deletions、各hunk headerの行数の一致状況
- `complete`、`partial`、`missing`、`excluded`とAPI上限候補のcoverage情報

patchがないファイルを黙って無視しない。binaryはline review不能として記録する。API additions/deletionsとparsed件数、またはhunk headerと実際の行数が不一致なら`partial`とする。大きなtext diffは`gh pr diff`またはローカル`git -C <VALIDATED_ROOT> diff <merge-base>..<head> -- <path>`で意味的レビューを補完できるが、現行scriptにはsnapshot-boundなlocal patch取込機能がない。API entryを手作業で`complete`へ書き換えず、inline投稿は見送り、coverage gapまたは承認対象の単発コメントとして扱う。

lockfile、generated file、vendor fileを除外する場合も、依存変更や手編集の有無を別経路で確認する。

## 3. Anchor解決

reviewerにはline番号を推測させず、変更行の原文を`code_anchor`として返させる。

1. `finding.path`に対応するdiffmap entryだけを検索する。
2. anchorの中心行を`text`へ完全一致させる。
3. 複数一致なら前後行で一意化する。
4. 追加された原因は`side=RIGHT`かつ`is_changed=true`、削除された原因は`side=LEFT`かつ`is_changed=true`を確認する。contextはanchorの一意化にだけ使い、target lineにしない。
5. 一意化不能なら静的inline候補から外す。

共通行をpath横断で検索しない。別ファイルや別hunkへ誤ってlineを付ける原因になる。

## 4. 投稿前ゲート

投稿内容の一覧をユーザーへ提示する前に、次を順番に行う。これらはツール側の整合チェックであり、ユーザーへの確認事項にしない。

1. 現在の`headRefOid`を再取得し、diffmapの`head_sha`と一致するか確認する。
2. 不一致なら、更新されたpathを再取得・再レビューする。古いfindingをそのまま移植しない。
3. 各`path`、`line`、`side`がdiffmapの同じsideに存在し、targetがchanged lineか確認する。削除行は`LEFT`、追加行は`RIGHT`を使う。
4. 複数行の場合は`start_line`と`start_side`も同じhunkのreviewable行か確認する。外れる場合は単一行へ落とす。
5. REST APIで既存review commentsを取得し、path、line、semantic anchor、本文で重複を除外する。
6. 既定は`KEEP`のHigh/Middleへ絞る。Low/Nitはユーザーがdraft範囲へ明示した場合だけ含め、`REVIEW`は常に除外する。
7. 投稿本文にsecret、PII、内部credential、過剰なログ引用がないことを確認する。

除外したfindingの件数と理由をユーザーへ報告する。

```bash
gh api --paginate \
  "repos/<OWNER>/<REPO>/pulls/<PR>/comments?per_page=100"
```

## 5. Payload、承認、投稿

既定eventは`COMMENT`とする。`REQUEST_CHANGES`、`APPROVE`はユーザーが投稿内容の一覧を見て明示した場合だけ使う。rendererのevent整合条件を緩めない。

scriptが生成するGitHub API payloadは次の形になる。これは出力例であり、手書きしない。

```json
{
  "event": "COMMENT",
  "commit_id": "<HEAD_SHA>",
  "body": "Merge判断と検証結果の短い要約",
  "comments": [
    {
      "path": "src/example.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "**[High]** 他ユーザーのIDを指定すると所有者確認なしで更新でき、データを改ざんできます。更新前にresource ownerとsession userを照合してください。"
    }
  ]
}
```

inline本文は[comment-writing.md](comment-writing.md)に従って構造化findingから中央生成する。内部の長い証拠はreview artifactへ保持し、GitHub本文へ貼り付けない。次の構造化入力を作る。

```json
{
  "event": "COMMENT",
  "commit_id": "<HEAD_SHA>",
  "review_body": "検証結果の短い要約",
  "findings": [
    {
      "severity": "High",
      "confidence": "high",
      "verdict": "KEEP",
      "path": "src/example.ts",
      "line": 42,
      "side": "RIGHT",
      "problem": "他ユーザーのIDを指定すると所有者確認なしで更新でき、データを改ざんできます。",
      "fix": "更新前にresource.ownerIdとsession.userIdを照合してください。"
    }
  ]
}
```

`scripts/prepare_review_payload.py`でhead SHAを`commit_id`へ束縛し、本文、verdict、severity、confidence、side、文字数、曖昧表現を検証してGitHub API用payloadへ変換する。手書きpayloadで検証を迂回しない。

payloadは一時JSONへ書き、`--input`で送る。

```bash
python3 scripts/prepare_review_payload.py \
  --input /tmp/pr-findings-<PR>.json \
  --diffmap /tmp/pr-<PR>-diffmap.json \
  --output /tmp/pr-review-<PR>.json
```

生成したpayloadの中身（event、review body、全commentのpath/line/side/本文、除外件数と理由）を読みやすい一覧で提示し、`この内容で投稿してよいですか？`と一度だけ確認する。head SHAやpayload hashの確認をユーザーへの確認事項として出さない。承認を得るまでGitHubへ送らない。

承認後は、生成したfileをそのまま送る。提示後にpayloadを作り直した場合だけ、新しい一覧を提示して確認をやり直す。

```bash
gh api --method POST \
  -H "Accept: application/vnd.github+json" \
  "repos/<OWNER>/<REPO>/pulls/<PR>/reviews" \
  --input /tmp/pr-review-<PR>.json
```

diff行へ責任を持って結び付けられないE2E findingは、単発コメントの完全な本文を提示し、別途承認を得た場合だけ投稿する。

```bash
gh pr comment <PR> --repo <OWNER/REPO> --body-file /tmp/pr-<PR>-runtime-findings.md
```

## 6. 失敗時の扱い

- `422 line is not part of diff`: diffmap、side、start_line、head SHAを再確認する。行番号を勘でずらさない。
- `422 path not found`: repository-relativeな新pathを使う。rename後は新pathを使い、削除anchorは`side=LEFT`とする。
- pending review: `event`欠落。勝手に別eventへ変えず、payloadを修正する。
- partial failure: review作成APIは一括で失敗しうる。投稿済みかをAPIで確認してから再送し、重複させない。
- head更新: 再レビューなしに投稿しない。

成功後は返却された`html_url`、投稿したseverity別件数、除外件数を報告する。

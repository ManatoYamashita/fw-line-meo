# gh CLI でインラインレビューを投稿する

PR の該当行に紐づくインラインコメントを、1 つの review にまとめて投稿する手順。
個別の `gh pr comment`(PR 全体への単発コメント)とは別物。inline は review API を使う。

**前提(pr-review-e2e の承認ゲート)**: この投稿は Phase 5 — つまりユーザーが Phase 4 のサマリーを
見て「投稿して」と承認した後にのみ行う。勝手に投稿しない。

**コメント本文は1行=`**[Sev]** <問題>。<修正方針>。` の簡潔形を厳守する**(詳細は SKILL.md Phase 5-2)。
冒頭に severity ラベル(`**[High]**` / `**[Middle]**` / `**[Low]**` / `**[Nit]**`)を付け、問題と修正を
**各1文・合計1〜2文**に圧縮。**見出し構造(`## なぜ問題か` / `## どう直すか`)は禁止**、本文は概ね 200 字以内。
修正案コードは High/Middle で必要な時のみ 1〜3 行のフェンスを添える(Low/Nit は付けない)。review の `body`
には最終 merge 判断(LGTM / 条件付き / 非推奨)とテスト結果サマリを数行で載せ、各指摘の詳細は再掲しない。

## diffmap の生成(1-1b。RIGHT 側実在行の許可集合 + is_new_code + 行テキスト + head_sha)

422(diff 外行)と既存コード誤検知を機械的に封じ、**かつ code_anchor → line 逆引きの唯一の真実源**に
なる前処理。親が1回だけ実行する。

### 取得(ページネーション必須)

`gh api repos/{owner}/{repo}/pulls/{PR}/files` は各ファイルの `patch`(unified diff)を返すが、
**1ページ30件・最大 `per_page=100`** に制限される。`--paginate` を付けないと31件目以降が黙って欠落し、
そのファイルへの全指摘が「diff 外」と誤判定される(大規模 PR で死ぬ)。必ず:

```bash
gh api --paginate "repos/{owner}/{repo}/pulls/{PR}/files?per_page=100"
gh pr view <PR> --json files --jq '.files | length'   # PR 総変更ファイル数(検算用)
gh pr view <PR> --json headRefOid --jq .headRefOid     # diffmap を束縛する head SHA
```

**検算**: 取得ファイル数を PR 総変更ファイル数と突合し、不一致なら未取得ファイルを Phase 4 カバレッジ欄に
列挙する(黙って欠落させない)。

### 行番号付与(CRLF 正規化 + 行テキスト保持)

patch のハンクヘッダ `@@ -a,b +c,d @@` の `+c` が**新しい側の開始行**。ハンク本文を上から走査し、
`+`(追加行)と ` `(コンテキスト行)の出現ごとに新しい側の行番号をインクリメントする(`-` 削除行は
進めない)。**`text` に格納する文字列は、行頭の diff marker(`+` または半角スペース1文字)を1文字除去し、
末尾 `\r` を strip(`sed 's/\r$//'` 相当)した本文にする** — code_anchor はソース原文(marker なし・`\r` なしで
LLM が再生成)なので、**両方を同じ前処理**(行頭 marker 除去 + CRLF 正規化)に通さないと固定文字列マッチが
先頭1文字 or 改行で 0 ヒットになる。CRLF だけ揃えて marker を放置するのは逆引きの片手落ち。

**行テキストを必ず保持する**。これが無いと code_anchor を grep する対象が存在せず逆引きが原理的に不能。
`gh api` + `jq` で patch を取り出し、行番号付与は小さなスクリプト(`tmp/diffmap.sh`。複数行コマンドは
devcontainer で壊れるため必ずファイル化)で行う。成果物:

```json
// /tmp/pr-<PR>-diffmap.json
{
  "head_sha": "abc123...",
  "files": {
    "frontend/app/foo/bar.tsx": {
      "42": { "is_new_code": true,  "text": "  const x = foo()" },
      "43": { "is_new_code": false, "text": "  return x" }
    }
  }
}
```

### patch==null の分岐(binary / truncate / rename)

`gh files` API は以下で `patch` を返さない(null)。区別して扱う:

- **truncate**(大規模 diff・additions/deletions が大): `gh pr diff <PR> -- <path>` で個別補完を試みる。
- **binary / 画像 / 生成物**(`gh pr diff` が `Binary files differ` のみ): 行コメント対象外。**許可集合から
  明示除外**しカバレッジ欄に1行記載(行が無いので逆引き・投稿の対象にしない)。
- **rename**(`status==renamed`): `filename`(新パス)を diffmap のキーにし、`previous_filename`(旧パス)は
  別フィールドに保持。**subagent への入力 path・逆引き・投稿は常に新パス(RIGHT)に正規化**する。
  review API は旧パスでは 422(path not found)になる。

許可集合 = この JSON `files` に存在する `(path, line)` の全体。投稿前ゲート(5-1)と line 逆引き(1-2b)は
この JSON だけを真とする。

## エンドポイント

```
POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
```

**`gh api` は git リポジトリ内なら `{owner}/{repo}` も `{pull_number}` も自動展開する** — カレント
リポジトリの PR レビューはそのまま `gh api repos/{owner}/{repo}/pulls/$PR/reviews` で通る(実測。
プレースホルダを手で埋める必要はない)。**別リポジトリを明示する場合だけ**、owner/repo を取って差し込む:

```bash
gh repo view --json nameWithOwner --jq .nameWithOwner   # 例: kozokaAI/kozoka-v2r
```

`gh repo view --json owner,name` は `owner` がネストオブジェクト(`{"login":"..."}`)で返るため、
素朴な流用は `.owner.login` を取り損ねる。`nameWithOwner` を使うのが安全。

## ペイロード形式

```json
{
  "event": "COMMENT",
  "body": "レビュー全体のサマリ(任意。観点別の要約を書くとよい)",
  "comments": [
    {
      "path": "frontend/app/foo/bar.tsx",
      "line": 42,
      "side": "RIGHT",
      "body": "**[Middle]** polling と sentiment 取得が競合し 0 件 toast になる。useReportSentiments を子セクション内で呼ぶ。"
    },
    {
      "path": "backend/app/handler/x.go",
      "start_line": 10,
      "start_side": "RIGHT",
      "line": 15,
      "side": "RIGHT",
      "body": "**[High]** この範囲の 500 経路が無音でデバッグ不能。`❌ <Handler> - <Step>: err=%v` 形式でログを足す。"
    }
  ]
}
```

- `event: "COMMENT"` — レビューコメントのみ。承認(APPROVE)も却下(REQUEST_CHANGES)もしない。
  `event` を省くと **pending(未公開)review** になり相手に見えないので必ず指定する。
- `line` — diff の**新しい側(RIGHT)の行番号**。エディタで見える行番号と一致する。
- `side: "RIGHT"` — 追加/変更行に付ける場合。削除行(LEFT)に付けるのは稀。
- 複数行範囲は `start_line` + `start_side` を `line`/`side` と併用する。`start_line < line`。

## 投稿コマンド

ペイロードを一時ファイルに書いてから `--input` で渡すのが最も安全。
heredoc や複数行インラインは devcontainer ターミナルで壊れるため、ファイル経由にする。

```bash
# 1. ペイロードを tmp に書く(JSON はツールで生成して Write で書き出す)
#    例: /tmp/pr-review-<PR>.json

# 2. 投稿
gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  "repos/{owner}/{repo}/pulls/{PR}/reviews" \
  --input /tmp/pr-review-<PR>.json
```

投稿に成功すると review オブジェクトが返る。`html_url` をユーザーに提示する。

## よくある失敗とその回避

- **422 Unprocessable Entity (line is not part of the diff)**: 指定した `line` が diff に
  含まれていない。コンテキスト行・削除行・差分外の行を指している。`gh pr diff <PR>` で
  RIGHT 側に実在する追加/変更行か確認する。
- **422 (path not found)**: `path` がリポジトリルートからの相対パスになっていない、
  または PR で変更されていないファイルを指している。リネームファイルは**新パス(RIGHT)**で指す。
- **複数行範囲の 422**: `start_line` も RIGHT 側の diff 内実在行でなければ 422 で**コメント全体が失敗**
  する。`line`(終端)だけ許可集合内でも `start_line` がコンテキスト行/差分外だと落ちる。Phase 5-1 の
  最終ゲートで `(path, start_line, start_side)` も必ず突合し、外れたら単一行 `line` コメントに降格するか除外する。
- **requested_reviewers の 422 と混同しない**: `POST .../requested_reviewers`(レビュアー再依頼)は
  REST で 422 になる既知の罠だが、**reviews 作成 API はこれとは無関係**で正常に動く。
- **pending のまま見えない**: `event` を省略した。`COMMENT` を必ず付ける。
- **ターミナルで JSON が壊れる**: インライン heredoc を避け、Write で tmp ファイルに書いて
  `--input` で渡す。

## E2E 結果のサマリ投稿 / diff 行に乗らない指摘の受け皿(単発コメント)

E2E 全体の結果サマリ、および **diff 行へ逆引きできない指摘**(実機リグレッションは症状画面と原因 diff 行が
離れている/原因が PR diff 外のことが多い)は inline ではなく PR 全体への単発コメントに回す:

```bash
gh pr comment <PR> --body-file /tmp/pr-e2e-summary-<PR>.md
```

最有力の diff 行があればそこに inline、無ければこの単発コメント + 再現 GIF。**1-2b の「逆引き不能は落とす」は
静的 findings 限定**であり、E2E 由来 findings には適用しない(検証 KEEP した実機 High を消さないため)。

## 定型コメントテンプレ(.env.example に新規環境変数が追加されたとき)

`.env.example` に追加行(`+ ` で始まる `KEY=` 形式)が検出されたら、その行に **inline コメント**として
以下の定型を Low 既定で投稿候補に起票する(投稿はユーザー承認後):

```
**[Low]** 新しい環境変数 `<KEY>` が増えています。Slack で他の開発者に共有してください
(devcontainer は `.env` を OS env として焼き付けるため、各開発者は再起動 or unset が必要です)。
```

複数 env が同 PR で増えた場合は、各 env 追加行ごとに1コメントを inline で起票するか、最初の追加行に1件
だけ inline でまとめて起票する(後者は本文に `<KEY1>, <KEY2>, ...` を列挙)。Phase 4 サマリーの
「特記事項 > 新規環境変数」欄にも件数と env 名一覧を表示し、ユーザーが投稿可否を即断できるようにする。

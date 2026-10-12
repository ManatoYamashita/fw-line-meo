---
name: pr-review-e2e
description: 'GitHub PR を多観点でレビューし、テスト・E2E まで検証したうえで、指摘事項(High/Middle/Low/Nit ラベル付き)・テスト結果・最終的な merge 判断(LGTM / 条件付き Merge 可能 / merge 非推奨)を まとめたサマリーをまず提示するスキル。観点別 subagent を並列起動し、反証専任の批判検証で誤検知を 抑え、diffmap で投稿行を機械チェックする精度重視の構成。effort(high / ultracode)で探索深度と 検証段数を上げられる。投稿はユーザーが承認してから gh CLI で簡潔にインライン投稿する(承認ゲート方式)。 ユーザーが「PR #123 をレビューして」「このPRをレビューして」「PRレビューしてE2Eまで」「pr-review」 「merge して良いか見て」「厳しめに/多観点でレビューして」「誤検知を潰してレビュー」「high でレビュー」 などと言ったら必ず使うこと。コードだけでなくテスト品質・既存機能へのリグレッション影響・PR の意図 整合性・後方互換・依存追加も見る。レビュー対象は PR 番号を引数に取る。Ghostty(ホスト)では静的レビュー、 E2E は devcontainer でサーバ起動後に Claude in Chrome(使えない場合は agent-browser にフォールバック)で 実行するという環境境界を前提にしたフェーズ構成。

  重要: レビュー結果は **勝手に PR へ投稿しない**。必ずサマリーを提示し、ユーザーが 「投稿して」と指示したときだけインライン投稿する。'
---

> このリポジトリで使用する前に [共通実行規則](../_shared/runtime.md) を読み、ツール・バージョン・承認の適用条件を確認する。

# PR レビュー + E2E スキル (pr-review-e2e)

GitHub PR を対象に、(1) ベストプラクティス静的レビュー、(2) devcontainer でのサーバ起動を挟み、
(3) Claude in Chrome で包括的 E2E テスト、(4) **全結果を統合したサマリー+merge判断を提示**、
(5) **ユーザー承認後にのみ簡潔なインラインコメントを投稿**、という流れで進める。

## 鉄則: 投稿は承認ゲートの後

このスキルの最重要原則。**レビュー・E2E の結果を勝手に PR へ投稿してはならない。**
Phase 1〜3 では所見を蓄積するだけで投稿しない。Phase 4 でサマリー(指摘ラベル + テスト結果 +
merge 判断)を提示し、**ユーザーが「投稿して」と明示的に指示したとき**だけ Phase 5 で投稿する。
ユーザーはサマリーを見て、投稿するか・どの指摘を投稿するか・そもそも投稿しないかを判断する。

## 環境境界

Ghostty(ホスト)では `pnpm dev` / `pnpm install` が禁止されているため E2E を直接実行できない。
E2E は人間が devcontainer でサーバを起動した後、Claude in Chrome 経由でブラウザを操作して行う。
この境界を破ろうとしてはならない — 破ると OOM や native binding 上書きで dev server が壊れる。

**ブラウザ操作手段のフォールバック**: E2E のブラウザ操作は **Claude in Chrome を第一選択**とする。
ただし Claude in Chrome が使えない場合(拡張が未接続・応答不能、`tabs_context_mcp` がエラーを返す、
ブラウザツールが ToolSearch で見つからない等)は、**`agent-browser` スキルにフォールバックする**。
どちらを使っても「ホストで dev server を起動しない / devcontainer で起動済みのサーバをブラウザから
叩くだけ」という環境境界は変わらない。フォールバックした場合は、その旨と理由を Phase 4 のサマリーに
明記する(エビデンスの取得手段が変わるため)。

## 引数

`/pr-review-e2e <PR番号>` の形で PR 番号を受け取る。番号が省略された場合は現在のブランチに
紐づく PR を `gh pr view --json number` で解決し、見つからなければユーザーに確認する。

## レビュー観点

以下の 6 観点でレビューする。各指摘は「なぜ問題か」と「どう直すか」をセットで述べる。
単なる好みの指摘や、既存コードに元々ある問題(この PR が触っていない箇所)は避ける。

1. **正確性・バグ** — ロジック誤り、null/undefined 処理、競合状態(polling race を含む)、
   エッジケース、エラーハンドリングの欠落。
2. **セキュリティ・パフォーマンス・依存** — 認証/認可の抜け、入力検証、機密情報漏洩、N+1、
   不要な再レンダー、バンドルサイズ、backend handler の無音 500 経路。**外部依存の追加**(go.mod /
   package.json / lock の `+` 行)は必ず1指摘として起票し、必要性・標準/既存での代替・メンテ/ライセンス/
   バンドル増分を問う。**本プロジェクトは外部ライブラリ追加に厳格** — 無断の新規外部依存は既定 Middle 以上
   (ブロッカー候補)。親は 1-1b 付近で go.mod/package.json の `+` 行を機械抽出し決定論的に起票する。

   **領域別の追加チェック**(該当 path に diff があるときのみ発火):
   - **backend/app/migrations/**.sql**(atlas 形式・単一 .sql ファイル): 大量データテーブルへのロック・
     書き換えによる**ダウンタイムリスク**(本番は ECS ローリングデプロイで即反映)、外部キーや頻繁検索
     カラムへの**index 漏れ**、**NOT NULL 制約+default 欠落**(既存行で失敗)、全走査クエリ、SQL injection。
     タイムスタンプ単調増加は F6 で別途見る。
   - **backend/(handler|usecase|service)/**.go**: **AppError/httperr 形式の一貫性**、sqlc/squirrel の
     **動的 WHERE での SQL injection**、不要な全件取得、ログに **PII/機密情報を載せていないか**、
     `slog.InfoContext` 等 Context 系を使い **request_id が乗っているか**、CloudWatch を汚染する過剰/
     無意味なログでないか、**変更系 usecase が audit funnel(`u.uow.Mutate` 経由)を通り監査記録されるか**、
     **deprecated フィールドへの代入/参照禁止**(後方互換フォールバック残置は Middle 以上)。
   - **frontend/app/、frontend/components/**(Next.js App Router): **dangerouslySetInnerHTML 等の XSS**、
     **WCAG 2.1 AA**(alt 属性・aria ラベル・キーボード操作)、React hooks 規則違反、不要な再レンダー、
     **Next.js の `Link` コンポーネント**ではなく素の `<a>` で内部遷移していないか。
3. **既存機能へのリグレッション影響・後方互換** — この変更が触る共有コンポーネント・API・状態が、
   他の画面や機能を壊さないか(E2E で実機検証)。加えて **DB schema / 公開 API の後方互換破壊**(F9):
   ECS ローリングデプロイで新旧コードが一時共存し、モバイル/Web 複数クライアントが居るため、破壊的変更は
   本番障害に直結する。NOT NULL+デフォルト無し列追加・列/テーブル/フィールドの削除/リネーム/型縮小/enum 削除を見る。
4. **テスト品質・カバレッジ** — テストの有無、境界値・異常系の網羅、モックの妥当性、
   flaky リスク。テストが無い変更には「どんなテストを足すべきか」を具体的に示す。
   **追加チェック**: 形だけでなく**振る舞い**を検証しているか・**mock しすぎ**て実際の振る舞いを
   テストできていないテストになっていないか・**テスト間依存が無く順番非依存で単体で通る独立性**。
5. **意図整合性** — この PR の宣言された意図(title / body / 紐づく Issue の受け入れ条件)に対し、diff が
   それを**達成しているか・取りこぼしていないか・矛盾していないか**。コードとして正しくても仕様を満たさない
   PR は merge すべきでない。1-1 で `gh pr view --json body,title` と body 中の `#<n>`/`Closes #<n>` から
   `gh issue view <n>` を取得し、この観点の subagent と親に渡す。
6. **仕様ドキュメント同期(F10)** — backend usecase/handler や frontend app/<機能> に diff があるとき、
   対応する **`.kiro/specs/<NNN>_*/`(個別 spec: requirements/design/tasks)** や **`docs/specs/<NNN>_*.md`
   (機能カテゴリ別ドキュメント)** が**実装と乖離していないか**を見る。受け入れ条件未充足・API 例の食い違い・
   古い記述の残置・実装に追従していない図/コード例。**対応 spec が無い**機能変更は新規追加 or 「spec 不要」の
   どちらに該当するかを意図整合性(観点5)に回す。**.env.example に新規環境変数の追加があれば、その追加に
   ついて『Slack で他の開発者に共有してください』と明示する文言を投稿候補として起票する**(Low 既定)。

### プロジェクト頻出 failure-mode チェックリスト

観点を散文で流すと見落としが出る。このプロジェクトで**実際に再発した**失敗モード F1〜F10 と、
subagent に注入する**前提知識**(transcription は Gemini 完結 / React 19 useRef / pnpm 単一構成 等)は
**`references/subagent-contracts.md` の共通ヘッダに一元定義**してある(親もその基準で見る)。要点だけ:

- **F1** useEffect 依存配列誤り / useCallback 欠落、**F2** RSC 無限ループ(`GET /?_rsc=` 連打)、
  **F3** polling 競合、**F4** backend 無音 500、**F5** 長命ブランチ merge の dead code 復活(golangci-lint
  でしか露見しない)、**F6** atlas migration 非線形、**F7** 光世/new テナント分岐混入、**F8** flex truncate 見切れ、
  **F9** DB schema / 公開 API の後方互換破壊(NOT NULL 列追加・削除/リネーム/型縮小・enum 削除。expand/contract で安全か)、
  **F10** **仕様ドキュメント乖離**(`.kiro/specs/<NNN>_*/` / `docs/specs/<NNN>_*.md` と実装の不整合 / 受け入れ条件未充足 /
  古い記述の残置 / 実装と食い違う API 例)。
- 各項目には「発火条件(この PR の diff が該当する場合のみ見る)」がある。**触っていない領域は見ない**
  — 触っていない箇所への指摘は禁止(観点末尾の鉄則)だからだ。詳細表は contracts を参照。
- **F1〜F10 は既知の再発パターンに過ぎない。クローズドリストとして扱わない。** どれにも当てはまらなくても、
  この PR 固有のロジック・不変条件・データフローを第一原理で読み**新種の欠陥を最優先で探す**。
  「リストに無いから見送る」「リストに当てはめるために指摘する」のどちらも禁止(確証バイアスの排除)。

## Phase 1: 静的レビュー (Ghostty) — 投稿せず所見を蓄積

このフェーズでは**投稿しない**。指摘候補を内部で蓄積し、Phase 4 のサマリーで提示する。

このスキルの精度の核は **(A) 決定論的前処理(diffmap)で 422 と既存コード誤検知を機械的に封じ、
(B) 観点別 subagent の並列探索で網羅性を上げ、(C) 反証専任の批判検証 subagent で誤検知(false
positive)を潰す** の3点にある。順序が重要 — 並列化(B)は壁時計を縮めるだけで質はほぼ上げない。
質を上げるのは (A) と (C) だ。だから (A) を最初に置き、(B) の各 subagent には (A) の成果物を渡す。

### 1-0. worktree 隔離(Phase 1 全体をメインレポから隔離)— 並行作業の保護

ユーザーが別の Claude Code セッションでメインの作業ブランチを使う可能性があるため、**Phase 1 の静的
レビューはメインレポを一切触らず、PR ブランチをチェックアウトした専用 worktree 内で完結させる**。これにより
メインレポのワーキングツリー・チェックアウト中ブランチに干渉しない(`git checkout` でメインを巻き込む事故を防ぐ)。
作成コマンド(取り残し掃除込み)は下記「ライフサイクル」のブロック参照。

**パス依存の整理**: 1-1 / 1-1b の `gh` 取得・diffmap 生成は**カレント非依存**でどこで実行してもよい(`gh` は
PR 番号で取得し git ツリーに依存しない)。**worktree のワーキングツリーを対象にするのは、1-3 の build/test と、
コード読解・subagent に渡すコード grep のみ**。注意:

- **worktree 内で `pnpm install` は禁止**(メモリの鉄則。native binding を上書きし dev server を壊す)。
  frontend の tsc/vitest が node_modules を要する場合は **メインrepo の `frontend/node_modules` を
  `ln -s` で symlink して借り、検証後 `rm` で撤去**する(worktree 側 install はしない)。
- **対象ブランチが devcontainer 側で使用中(別セッションが E2E 等で使う予定)なら worktree を作らない** —
  同一ブランチは複数 worktree で同時チェックアウトできない(git 仕様)。その場合は 1-0 をスキップし、
  メインレポで読む(ただしメインのブランチを切り替えない範囲で。切替が要るなら Phase 2 の承認フローに従う)。
- subagent には**この worktree の絶対パス**を渡し、コード読解・grep をそのツリー内に閉じる。

**ライフサイクル**(撤去トリガは下記の単一条件に固定。複数箇所で言い換えない): 作った worktree は **1-4 で
必ず撤去**する。トリガは「E2E に進むか」で2分岐 —(i)E2E 非進行/スキップなら **Phase 4 提示後(投稿時は
Phase 5 完了後)**、(ii)E2E 進行なら **Phase 2 でブランチ切替がユーザー承認された後・`git checkout` 実行の
直前**(承認前には撤去しない — 拒否時に Phase 1 続行の余地を残すため)。異常終了・中断時の取り残しを防ぐため、
**作成前**(下記コマンドの先頭)と**完了報告前**の2点で `git worktree list` を確認する。

```bash
# 1-0 冒頭: 前回の取り残しを先に掃除(同名パス衝突による作成失敗も防ぐ)
git worktree list                                            # kozoka-v2r-prreview-* の残骸を確認
git worktree remove --force ../kozoka-v2r-prreview-<PR> 2>/dev/null || true   # 残骸があれば撤去
git worktree prune
# 作成
git fetch origin <headRefName>
git worktree add ../kozoka-v2r-prreview-<PR> <headRefName>
```

### subagent 起動規約(Agent ツールで実装。Workflow は同梱しない)

並列探索・批判検証は **Agent ツール**で subagent を起動して行う。subagent は親の会話・CLAUDE.md・
MEMORY.md を**継承しない**ため、以下を**全 subagent の prompt 冒頭に必ず注入する**。注入漏れは
汎用レビューへの退行を招き、むしろ精度が落ちる(`references/subagent-contracts.md` にテンプレ全文):

1. **環境境界**: subagent は worktree を作らない(親が 1-0 で用意した worktree の絶対パスを渡されるので、
   その**ツリー内を read-only で読む・grep するだけ**)/ ホストで `pnpm dev`・`pnpm install`・`make run-dev`
   禁止 / 複数行コマンドは `tmp/*.sh` 化 / `git checkout`・`git worktree add/remove` は親のみ。
   **subagent は read-only 静的解析のみ**。worktree 作成・撤去・ビルド検証は親が一括実行し結果を配る。
2. **failure-mode チェックリスト**(上記 F1〜F9。クローズドリストとして扱わない旨も)と前提知識。
3. **severity 基準**(下記)。
4. **diffmap(当該 subagent が見る path 分)と diff 本文**(下記 1-1b で親が生成)。subagent に `gh` を
   叩かせない。観点5(意図整合性)の subagent には PR body/title/紐づく Issue も渡す。

### 起動ゲート(規模 + effort の両方で分岐)

固定で重い並列+2段検証を回すのはコスト・レイテンシの無駄。以下で起動深度を決める。

**この運用は最終フィルタが人間**(Phase 4 サマリーを人間が読み、E2E でも人間待ちが入る)。だから AI 側で
網羅性を機械的に追い込むより、規模に応じて段階を選ぶ。effort 無指定の素朴な呼び出しが最も多いので、その
既定を軽く保つ(重すぎて使われなくなるのを防ぐ)。

**規模ゲート(3 段)**:

- **軽微 PR**(目安: 数百行 / 数ファイル未満。effort 無指定時の既定の裾野): **観点探索を並列化せず親が
  直列レビュー**(=「親単独」は探索を並列起動しないの意。批判検証 1-2c の反証スレッド分離は規模に依らず維持
  する — これは生成と検証を分けるための別物)+ 検証1段。diffmap(1-1b)と批判検証(1-2c)は規模に依らず必ず行う。
  **親の直列レビューでも `references/subagent-contracts.md` の共通ヘッダ(F1〜F10・前提知識・severity 基準)を
  自身のチェック基準として読み込んでから**行う(探索 subagent を起動しないと注入ステップが発生せず汎用レビューに退行するため)。
- **中〜大規模 PR**: 観点別並列(1-2a)を起動。各 subagent には全 diff 本文を渡すが、**diffmap は当該
  subagent が見る path のエントリだけ**を渡す(全 path 配布をやめてコピー爆発を抑える。ただしリグレッション
  観点3 は横断影響検出のため全 path 必須)。
- **超大規模 PR**(目安: 1 subagent に乗る diff が概算上限〔~2000行 / ~200KB〕を超える): 全 diff を1本に乗せると
  prompt が膨張・切詰めが起きる。**同時並列は最大5本のまま**、変更密度の高いファイル群で**シャーディングして
  ターンを分ける**(本数を増やすのではなくターンを分割 — `batch は小さく刻む` 鉄則と整合)。**リグレッション
  観点3 だけは全 diff 必須**、他観点はシャード可。配り切れず縮退した範囲は Phase 4 カバレッジ欄に「縮退レビュー」と明記。

**effort 連動**(effort はユーザーが明示する語。無指定 = 既定/medium 動作。effort 段階表はここを正準とし、
contracts は本節を参照する。**観点6 は knowledge_base 抽出ヒットがある PR でのみ起動**。ヒット 0 件は本数から除外):

- **既定(無指定 / medium)**: 軽微 PR は親単独。中規模以上は6観点を**3本に束ねて並列**(例: 正確性+意図整合性 /
  セキュリティ依存+リグレッション後方互換 / テスト品質+仕様同期)+ 検証1段。1本が複数観点を担当する束ね方でよい。
- **`high`**: 6観点を1観点1本でフル並列(最大6本 → ただし同時並列上限は5なので**観点5と6を1本に束ねる**等で5本以内に
  収める)+ 検証2段(2段目 = false-negative ハント)。
- **`ultracode`**: `high` + false-negative ハント(1-2c 2段目)を**全観点に拡張** + 横断再走査を複数パス +
  Nit も検証対象に含める。**観点6 の knowledge_base 抽出も fuzzy 一致閾値を緩めて広めに当てる**(該当 spec を
  見落とさない方向に倒す)。

「網羅したいなら `high` を指定」とサマリー冒頭で案内し、ユーザーがコストを意図的に選べるようにする。
`batch は小さく刻む / ネストを深くしない`(harness 破綻回避)に従い、同時並列本数と集約ネストを深くしない
(**同時並列は最大5本**を超えるならターンを分ける)。

### 1-1. PR の取得と差分把握(意図も取る)

```bash
gh pr view <PR> --json number,title,url,headRefName,baseRefName,headRefOid,body,files
gh pr diff <PR>
# body 中の #<n> / Closes #<n> から紐づく Issue を取得(意図整合性=観点5 の判定材料)
gh issue view <n> --json title,body
```

`headRefName`(PR のブランチ)と `baseRefName` を控える(E2E でブランチ名が要る)。`headRefOid`(head SHA)も
控える(diffmap の束縛・投稿前の陳腐化検出に使う)。`url` は Phase 4 のサマリー見出しでクリック可能リンクに。
**body / title / 紐づく Issue 本文**は観点5(意図整合性)の subagent と親に渡す材料として保持する。

### 1-1b. diff 正規化(親が1回だけ実行)— 422 と既存コード誤検知の決定論的封じ込め

**最も費用対効果の高い前処理。** LLM を増やさず誤検知を機械的に落とす。親(このセッション)が
`gh files` API の patch を**1回だけ**解析し、`/tmp/pr-<PR>-diffmap.json` を作る(完全な手順・スキーマ・
CRLF 正規化・binary/rename 分岐は `references/gh-inline-review.md` 参照)。要点:

- **`--paginate "...?per_page=100"` 必須**。無印は30件で切れ、31件目以降が黙って欠落する。取得ファイル数を
  `gh pr view --json files` の件数と**検算**し、不一致は未取得ファイルをカバレッジ欄に列挙。
- 成果物は `{head_sha, files:{path:{line:{is_new_code, text}}}}`。**行テキスト `text` を必ず保持**
  (これが無いと code_anchor の grep 逆引きが原理的に不能)。各行は末尾 `\r` を strip して正規化する。
- これで **(a)** RIGHT 側実在行の許可集合(gh review API に通る行)と **(b)** 各行の `is_new_code`(追加/変更行か
  既存コンテキスト行か)が決定論的に確定する → 指摘行が diff 外なら投稿前に弾け(422 を構造的に防止)、
  `is_new_code=false` への指摘は「既存コード由来」として落とせる(誤検知の二大要因の一つを封殺)。
- **patch==null の分岐**: binary は許可集合から除外、truncate は `gh pr diff -- <path>` で個別補完、rename は
  新パスをキーにする(詳細は references)。補えないものはカバレッジ欄に明記。

**path_filters による許可集合からの機械除外**: diffmap 生成時に以下を**許可集合から除外**する
(指摘自体を起票させない・投稿前ゲートで弾く前段)。除外したファイルは Phase 4 カバレッジ欄に「path_filter
除外: <pattern>」と1行記載する(黙って消さない)。除外対象:

- `**/node_modules/**`(依存物)
- `frontend/dist/**`(ビルド成果物)
- `cdk/cdk.out/**`(CDK ビルド成果物)
- `**/pnpm-lock.yaml` / `**/package-lock.json` / `backend/go.sum`(lock。**依存検出は下記の別経路**)
- **将来追加されたら除外**: `frontend/src/generated/**`(orval 生成物。手編集は別途指摘 — 下記)、
  `backend/api/openapi.gen.yaml`(huma 生成物)、`old_product/**`、`fujii_origin/**`

**生成物への手編集検出(観点2 サブチェック)**: `frontend/src/generated/**` / `backend/api/openapi.gen.yaml` は
**diffmap から除外する一方で**、これらが diff に含まれていたら**親が「生成物が手編集されている疑い・orval や huma
の再生成で消える変更がないか」を Middle 既定で起票**する(除外と検出は両立する)。

**依存追加の決定論的起票(観点2)**: path_filter で lock 系を diffmap から除外する**前段で**、go.mod / go.sum /
package.json / pnpm-lock.yaml の `+` 行を機械抽出し、新規外部依存があれば **LLM の見落としに依らず1つの指摘候補
として必ず起票**する(diffmap と同じ「決定論で見落としを構造的に封じる」思想)。指摘の path は依存名を持つ
ファイル(go.mod / package.json)を指す。

### 1-1c. knowledge_base の抽出(親が読み subagent に注入)

PR diff の path とキーワードから関連する仕様/ガイドラインを**親が抽出**し、subagent 注入用の素材として
`/tmp/pr-<PR>-knowledge.md` に書き出す(subagent に大量ファイルを Read させない — トークン肥大とレイテンシ
増大を避けるため)。抽出対象:

- **`.kiro/steering/`**(product.md, tech.md, structure.md): **全 subagent 共通**で注入する基礎知識。
  各ファイルの先頭セクション(概要 + 規約)を抜粋する。
- **`.kiro/specs/<NNN>_*/`**(個別 spec: requirements.md, design.md, tasks.md): PR title/body/diff path の
  キーワード(例: "audio", "report", "auth", "mobile" 等)で `ls .kiro/specs/` の `<NNN>_<keyword>_*` ディレクトリ名を
  fuzzy 一致させ、ヒットした spec の requirements/design を抜粋。**観点5(意図整合性)subagent**と**観点6
  (仕様同期)subagent**に注入。
- **`docs/specs/<NNN>_*.md`**(機能カテゴリ別: 全体フロー/音声録音/AI処理/レポート管理 等): backend の handler/usecase
  名や frontend の app/<feature> 名でカテゴリを当て、該当 1〜2 ファイルを抜粋。**観点6 subagent**に注入。
- **CLAUDE.md**: 親が冒頭で読み込み済み。共通ヘッダの「環境境界」「前提知識」に主要点を反映済みなので、
  subagent への個別注入は不要。

抽出ロジックは決定論的に: PR diff path の prefix と spec ディレクトリ名/ファイル名の prefix(`backend/`、
`frontend/app/(?<feature>)`、`mobile/` 等)でマッピングする。ヒットゼロなら「該当 spec なし」として **観点6
subagent を起動しない**(空振りで Phase 4 にノイズが乗るのを避ける)。**カバレッジ欄に「知識抽出: spec NN 件・
steering 全件注入」と記録**する。

### 1-2. 観点別並列探索 → 集約 → 批判検証(精度の本体)

#### 1-2a. 観点別並列探索(Agent ツール)

各観点を担当する subagent を **Agent ツールで並列起動**する。**全 subagent に全 diff を渡す**
(観点別に diff を切り分けない)。共有コンポーネント変更のリグレッション(観点3)のように
「触った箇所と壊れる箇所が離れている」指摘や、観点をまたぐ横断バグを拾うために、横断文脈の保持が要る。

各 subagent への入力契約・出力スキーマは `references/subagent-contracts.md` に固定定義。要点:

- **入力**: 全 diff 本文 + diffmap(該当 path 分)+ headRefName + 担当観点定義 + failure-mode チェックリスト +
  severity 基準 +(観点5 のみ)PR body/title/紐づく Issue。
- **出力(JSON)**: 各指摘に `{perspective, path, code_anchor(指摘行の原文+前後1行), is_new_code(diffmap
  照合の真偽), is_novel_pattern(F1〜F9 のどれにも当てはまらない新種か), provisional_severity, failure_mode
  (F1〜F9 or null), claim, preconditions(成立前提を箇条書き), evidence(diff 引用), suggested_fix}`。
  **line は subagent に算出させない** — `code_anchor` だけ返させ、親が diffmap で逆引きする。
- 出力受領は **`references/subagent-contracts.md` の受領規約**に従う(本文末尾の ```json フェンスを親が抽出・
  パース。StructuredOutput ツールは前提にしない。パース失敗時は再起動1回 → なお失敗ならその観点を縮退)。
- `preconditions` と `is_new_code=true` が埋まらない指摘は出力させない(後段の反証可能性を担保)。
- 各観点に「この PR の diff が該当ファイルに触れている場合のみ発火」のガードを付ける。`is_novel_pattern=true`
  は歓迎する(「リストに無いから見送る」は禁止)。

#### 1-2b. 親による集約・dedup・横断再走査(1回目)

並列探索の結果を親が集約する:

- **dedup**: `(path, 行レンジの重なり)` **AND** 指摘の意味的同根 の **AND 条件**で重複を1件に統合し、
  観点タグを複数付与する(AND なので、行が重なるだけの無関係2指摘を誤って畳まない)。
- **横断再走査**: 観点を縦割りすると「認証漏れ×polling 上書き」「useEffect 依存×無音500」のような
  観点境界のバグを誰も全体像で捉えられない。集約後に**親が全 diff を俯瞰し、観点をまたぐ複合欠陥が
  ないか**を1パス見る(`/effort ultracode` ではここを厚く)。`is_novel_pattern=true` の指摘は必ず1件ずつ吟味する。
- **line 逆引き(暫定)**: `code_anchor` を diffmap の **`text` フィールドに照合**して line を確定する
  (patch を生で grep するのではない — diffmap が唯一の真実源)。**diffmap の `text` は行頭 diff marker 除去 +
  CRLF 正規化済みの原文**であり、code_anchor(同じく原文)と同前処理で揃っているから固定文字列マッチが効く。
  **grep は必ず `finding.path` のエントリ内に限定**する(`if err != nil {` 等の定型行は多ファイルに頻出し、
  path 限定なしでは別ファイルへ誤確定する)。path 内でも複数ヒットする場合のみ前後1行アンカーで解決し、
  なお一意化できなければ **line 未確定としてカバレッジに回す**(投稿対象から外す)。静的 findings の逆引き不能は
  この時点で落とすが、**E2E 由来 findings には適用しない**(単発コメントに回す。3-4 参照)。

#### 1-2c. 批判検証(Agent ツール・反証専任)

集約後の指摘群に対し、**反証バイアスの reviewer-critic subagent** を Agent ツールで起動する。
**生成と検証をスレッド分離**することで sycophantic な自己追認(anchoring)を断つのが目的。

**severity ゲート(検証コストの非対称を解消)**: 批判検証と severity 確定の対象は既定で **High/Middle/Low に
限定**する。Nit は反証検証を通さず親が機械的に軽量列挙するだけ(検証 subagent のトークンを Nit の真偽判定に
費やして既定で投稿除外する非対称を避ける)。`/effort ultracode` 等で明示されたときだけ Nit も検証対象に含める。

- **入力**: 元 subagent の断定結論(`provisional_severity`/`claim`)は**伏せ**、『未確定の容疑』として
  diff 該当行+周辺コンテキスト・`preconditions`・diffmap をワンセットで渡す。指摘テキストだけ渡すと
  検証側がコードを再読する空振りが起きるため、コンテキスト同梱は必須。
- **固定3チェック**: (a) 指摘行が diffmap の追加/変更行に実在するか (b) 主張するバグ/脆弱性が周辺
  コード・既存ガード・型システムで既に防がれていないか (c) この PR が触った箇所か(既存問題の誤指摘でないか)。
- **判定4値 + 理由**: `KEEP`(維持・再現シナリオ確定)/ `DOWNGRADE`(severity 格下げ・条件付き)/
  `REJECT`(誤検知)/ `REVIEW`(要確認・低確度。棄却しきれないが確信も持てない)を理由付きで構造化返却。
- **安全則(over-suppression / false negative 防止)**: 『データ破損・セキュリティ・確実なバグは
  REJECT/DOWNGRADE 禁止。迷ったら REJECT せず **`REVIEW`(要確認・低確度)**枠に回す』。検証段が
  正しい High を握り潰すのが最も危険な失敗。
- 検証 subagent のチェックリストに**誤検知の典型**(タイミング非決定の断定 High 化・既存コード混同・
  存在しない並行呼出しの仮定)を注入する。

`/effort high` 以上では検証を2段にする(2段目=承認指摘群に対し『見逃している High はないか』を
diff 再走査する false-negative ハント)。

#### 1-2d. 親による severity 確定(2回目集約)

検証を通った(`KEEP`/`DOWNGRADE`)指摘について、親が **PR 全体を俯瞰して severity を付け直す**
(subagent の `provisional_severity` は参考値)。観点内ローカル評価では「この PR で最も重いのはどれか」
の横断比較ができないため。`REJECT`/`DOWNGRADE`/`REVIEW`(要確認・低確度)は別枠に保持し、Phase 4 の
サマリーで透明に提示する(棄却ログ。検証段の false negative を監査可能にするため)。

**確定 findings の永続化(必須)**: severity 確定の直後(Phase 4 提示の前)に、確定 findings 全件 +
棄却/格下げログ + テスト/E2E 結果 + 観点5 の意図充足度を `/tmp/pr-<PR>-findings.json` に Write で書き出す。
Phase 4 提示 → 人間の E2E 準備 → 承認 の間に E2E のツール往復(GIF/console/network)でコンテキストが
compaction されると detail や棄却理由が劣化・消失するため。**Phase 5 はこの JSON を真として payload を組み**、
会話コンテキストの記憶に依存しない。再レビュー時の重複突合元(Phase 5-1)にもこの JSON を再利用する。

#### severity ラベルの基準(全 subagent と親で共有)

High=merge ブロック(データ破損・セキュリティ・確実なバグ・既存機能破壊)/ Middle=merge 前に直したい
(条件付きバグ・設計懸念・抜けたテスト)/ Low=必須でない(可読性・小さな非効率)/ Nit=好み・スタイル。
詳細は `references/subagent-contracts.md` の共通ヘッダと同一基準。

指摘が多すぎる場合は High/Middle を優先し、Nit は数を絞る。瑣末な指摘で PR を埋め尽くすのは害。
**既存コードに元々ある問題(この PR が触っていない箇所)は指摘しない**(diffmap の `is_new_code` で機械担保)。

各指摘の最終形は `{severity, path, line, perspective(複数可), summary, detail, verdict, 根拠}`。
`summary` は **1〜2文の簡潔な結論**(なぜ問題か＋どう直すかを各1文)。`detail` は Phase 4 サマリーや棄却監査で
人間が深掘りするための詳しい説明(背景・再現条件・代替案)。**投稿される inline コメントは `summary` を元に組む**
(`detail` を本文に流し込まない — これがコメント肥大の主因)。`detail` をコメントに載せたい場合も、結論を 1〜2 文へ
要約してから載せる。投稿時の本文フォーマットは Phase 5-2 の必須ルールに従う。

### 1-3. ビルド・テスト検証(親が 1-0 の worktree で一元実行 → subagent に配る)

レビュー精度の客観的土台。**親(オーケストレータ)が 1-0 で作った worktree 内で1回だけ実行**し、結果を
共有して subagent に配る(新たに worktree を作らない — 1-0 のものを再利用)。**subagent に worktree を
作らせない・ビルドさせない**(同一ブランチ複数チェックアウト禁止=git 仕様/プロジェクト鉄則。並列 subagent が
各自 worktree を作ると競合・多重ビルドが起きる):

- backend(Go): 1-0 の worktree で `go build ./...` / `go vet` / 関連 `go test`(並行系は `-race`)。
- frontend(TS): `tsc --noEmit` / 関連 vitest(filter は `--` なしで渡す)。**node_modules は 1-0 の symlink
  で借りる**(worktree 側 `pnpm install` は禁止)。**借用前に依存系ファイルのブランチ一致を確認**: メインrepo の
  現在ブランチと PR の `headRefName` で `package.json` / `pnpm-lock.yaml` が一致するか diff で見る。不一致なら
  借りた node_modules は別バージョンで型解決・依存挙動が汚染されるため、**型/単体検証は「node_modules 不整合のため
  未実施」としてカバレッジ欄に明記**し、誤った緑を出さない(devcontainer で正しい install 後に検証する選択肢を残す)。

**failure-mode 連動の追加検証**(build/vet/test を素通りする最重要 failure mode に 1:1 で当てる):

- **merge 系 PR(F5)**: `golangci-lint`(unused)を必須化。dead code 復活は build/vet/test では露見しない。
- **migration 差分(F6)**: `atlas migrate status`(SSM tunnel 経由)。非線形を検出する。
- **テナント分岐に触る差分(F7)**: `NEXT_PUBLIC_KOSEI_TENANT_ID` 経路を grep し混入を確認する。

Ghostty ホストで実行不可なもの(SSM tunnel 必須等)は**無理に実行せず**、Phase 4 のカバレッジ欄に
「未実施」と正直に明記する(できない検証を前提にしてスキルを詰まらせない)。検証が赤なら該当指摘の
severity を昇格させる(例: test 赤 → 該当箇所を High に)。

検証結果(緑/赤、件数、所要)を **テスト結果サマリ**として蓄積する。Phase 4 で提示する。

### 1-4. worktree の撤去(単一トリガ。1-0 ライフサイクルと同一規約)

1-0 で作った worktree を**必ず撤去**する。トリガは「E2E に進むか」の2分岐(言い換えない):

- **E2E に進まない / スキップ**(「投稿しない」と言われた終端も含む): **Phase 4 提示後(投稿時は Phase 5 完了後)**に撤去。
- **E2E に進む**: **Phase 2 でブランチ切替がユーザー承認された後・`git checkout` 実行の直前**に撤去する
  (承認前には撤去しない)。同一ブランチを worktree とメインレポで二重チェックアウトできないため、checkout が
  失敗 or 競合するのを防ぐ。承認が拒否されてスキップに転んだ場合は worktree を残したまま Phase 4 に戻り、上の経路で撤去する。

**撤去コマンド(symlink 撤去を全 remove 経路の前段に固定)**:

```bash
rm -f ../kozoka-v2r-prreview-<PR>/frontend/node_modules   # 借りた symlink を先に外す(--force 経路でも必ず先行)
git worktree remove ../kozoka-v2r-prreview-<PR>            # 変更が無ければそのまま
# 変更が残る等で失敗したら(symlink 撤去後): git worktree remove --force ../kozoka-v2r-prreview-<PR>
git worktree prune                                         # 参照のクリーンアップ
```

`rm -f <symlink>` はリンク実体だけを消し、リンク先(メインの `node_modules`)を巻き込まない。**完了報告の前**に
`git worktree list` で残存が無いことを確認する(取り残しの後追い掃除は 1-0 冒頭で行う)。**worktree を放置しない**
(対象ブランチを占有し続け、devcontainer や別セッションがそのブランチを使えなくなる)。

## Phase 2-3: devcontainer サーバ起動 + ブラウザ E2E

E2E 検証の詳細手順は **`references/e2e-runbook.md`** に切り出してある(切替承認・dev server 再起動依頼・
ブラウザ操作・エビデンス取得)。実機検証に進むときに読む。守るべき要点だけここに残す:

- **前提: 1-0 の worktree を撤去してから checkout する**(1-4)。E2E はメインレポを `git checkout` するため、
  同一ブランチを worktree が占有したままだと二重チェックアウトで失敗する。撤去のタイミングは下記の**切替承認を
  得た後・`git checkout` 実行の直前**(承認前には撤去しない。拒否/スキップ時は worktree を残し Phase 4 へ戻る)。
- **ブランチ切替はホスト(このセッション)側で `git checkout <headRefName>`**。全タブ・devcontainer を
  巻き込む**破壊的操作**なので、**実行前に必ずユーザーの承認を取る**。並行作業がある/今は切替たくない
  場合は E2E をスキップし、静的レビュー + テスト結果だけで Phase 4 に進む(その旨をサマリーに明記)。
- 切替後、**dev server 再起動はユーザーが devcontainer 側で**行う(backend `make run-dev` 再起動は
  古いバイナリ対策で必須、frontend は `rm -rf frontend/.next` → `pnpm dev`)。合図が来るまで Phase 3 に進まない。
- **Phase 3 冒頭で「正しいブランチで起動しているか」を必ず確認**(PR が触った画面を1つ開き Build Error が
  無いこと)。これを飛ばすと別ブランチで E2E を回して誤報告する事故になる。
- ブラウザは **Claude in Chrome を第一選択**、使えなければ **agent-browser** にフォールバック(理由を
  カバレッジ欄に明記)。RSC 無限ループ(F2)/polling 停止(F3)を疑う。**ダイアログ厳禁**(拡張が応答不能化)。
- E2E で見つかったリグレッションは Phase 1 リストに直接足さず、**1-2c の批判検証3チェックと 1-2d の集約を
  同じく通す**(検証済 / 未検証の二系統混在を避ける)。「既存コード由来でないか」「この PR が原因か」を必ず確認。
  **E2E 由来 findings は diff 行へ逆引きできないことが多い**(症状画面と原因 diff 行が離れる/原因が diff 外)。
  逆引き不能でも落とさず、最有力 diff 行があれば inline、無ければ**単発コメント + 再現 GIF** に回す(gh-inline 参照)。
- **E2E をスキップした場合**、リグレッション観点(観点3)の指摘は「実機未検証」である。Phase 4 では実機検証済と
  未検証を**区別して表示**し、未検証のリグレッション指摘を自動 High 化しない(確度を落として `REVIEW` 寄りに置く)。

## Phase 4: サマリー提示と merge 判断(承認ゲート)

ここがこのスキルの要。**まだ投稿しない。** Phase 1〜3 の全結果を統合し、ユーザーが
「投稿するか / merge してよいか」を判断できるサマリーをチャットに提示する。

### 4-1. サマリーの構成

以下の順で簡潔に提示する(冗長な引用は避け、判断に必要な情報に絞る):

```
## PR #<番号> レビューサマリー: <タイトル>

<PR の url を Markdown リンクとして 1 行で明記する。例:
レビュー対象: <https://github.com/{owner}/{repo}/pull/<番号>>
これにより、後からどの PR をレビューしたかをサマリーだけで辿れる。>

### 最終判断: <LGTM | 条件付き Merge 可能 | merge 非推奨>
<1〜2 行で理由。条件付きなら「何を直せば merge 可能か」を明記。effort 無指定で軽量モードだった場合は
「網羅したいなら `high` 指定で再レビュー可」と1行添える>

### 変更概観(条件付き) — backend/frontend/cdk のいずれかに差分があるとき
<モジュール別に1行ずつ。該当ゼロのモジュールは行ごと省略>
- backend: <変更ファイル数・主な領域(handler/usecase/migration 等)>
- frontend: <変更ファイル数・主な領域(app/<feature> / components / hooks 等)>
- cdk: <変更ファイル数・主な領域(stack/construct 等)>

### 特記事項(条件付き) — 該当時のみ表示。該当 0 件なら欄ごと省略
<以下のサブ項目は該当差分があるときだけ出す(空振り回避)>
- **DB マイグレーション**: `backend/app/migrations/` に追加/変更 N 件。タイムスタンプ <最新>・破壊性(列削除/型縮小/NOT NULL+default 欠落)有無・index 漏れ疑い。
- **公開 API 後方互換(F9)**: `backend/(handler|api)/` で削除/リネーム/型縮小/enum 削除を検知。ECS ローリング新旧共存 + モバイル/Web 複数クライアント影響を明記。
- **audit funnel**: 変更系 usecase に `u.uow.Mutate` 経由が無い箇所 N 件(該当 file:line)。監査記録漏れの懸念。
- **新規環境変数**: `.env.example` に新規 env N 件追加(<env 名一覧>)。**Slack で他の開発者に共有する旨を投稿候補に含める**(Low)。
- **生成物への手編集疑い**: `frontend/src/generated/**` or `backend/api/openapi.gen.yaml` に diff あり。orval/huma 再生成で消える変更がないか確認(Middle)。
- **新規外部依存**: `<go.mod | package.json>` に + 行 N 件(<名前一覧>)。必要性・代替・メンテ/ライセンス/サイズを問う(Middle 既定)。
- **仕様ドキュメント同期(F10)**: 関連 `.kiro/specs/<NNN>_*/` または `docs/specs/<NNN>_*.md` の更新要否 N 件。

### 意図充足度: <満たす | 一部未充足 | 逸脱>
<観点5。PR の title/body/紐づく Issue の受け入れ条件に対し diff が達成しているか。一部未充足/逸脱なら具体的に>

### テスト結果
- ビルド/型: <go build / vet / tsc 等の結果>
- ユニット/統合: <件数・緑赤・-race 有無>
- E2E: <通ったシナリオ / 落ちたシナリオ。エビデンス GIF 名 / スキップ時はその旨>

### 指摘事項
| Sev | 箇所 | 観点 | 実機 | 指摘(簡潔) |
|-----|------|------|------|-------------|
| High | file:line | 正確性 | — | … |
| Middle | file:line | リグレ | 検証済/未検証 | … |
| Low | file:line | テスト | — | … |
| Low | file:line | 仕様同期 | — | … |

(High/Middle が 0 件なら「ブロッカーなし」と明記。「実機」列はリグレッション観点のみ記入し、E2E スキップ時は
未検証を明示。Nit はこの表に出さず下記「Nit」欄に件数のみ)

### Nit — 折りたたみ
<件数のみ先頭表示。表に出すのは最大5件、超過は「他N件」。瑣末で埋め尽くさない>

### 要確認(低確度 / REVIEW) — 任意
<批判検証で `REVIEW` 枠に回った指摘。件数 + 1行ずつ。0 件なら省略>

### 検証で棄却/格下げした指摘 — 折りたたみ
<批判検証(1-2c)で REJECT / DOWNGRADE した件数と理由を簡潔に。検証段の false negative を
ユーザーが監査できるようにするための欄。件数のみ先頭に出し、詳細は折りたたむ想定>

### カバレッジ / 未検証
<どの観点 subagent が走ったか、何を実行できなかったかを箇条書き1行/項目で正直に。例:
- 静的: go build/vet/test 緑、tsc 緑、golangci-lint(unused)未実行
- atlas migrate status: SSM tunnel 必須のため未確認
- E2E: スキップ(ブランチ切替未承認) / Claude in Chrome 不可で agent-browser にフォールバック
- diffmap: <path> は patch truncate/binary により許可集合未生成、gh files 取得 N/M 件(未取得あり)>

### 次の一手
「無指定なら既定で High/Middle/Low を投稿します(Nit は除外)。範囲を絞る(例: High と Middle だけ)ことも、
投稿しないこともできます。投稿してよければ『投稿して』と言ってください。」
```

### 4-2. merge 判断の基準

- **LGTM**: High/Middle の指摘が無く、テスト・E2E が緑、意図充足度が「満たす」。そのまま merge 可。
- **条件付き Merge 可能**: Middle はあるが High が無い、または「この点を直せば/確認すれば OK」と
  言える状態。**条件を具体的に**書く。
- **merge 非推奨**: High が 1 件でもある、テスト/E2E が赤、リグレッションを検知、**意図整合性が逸脱**、
  **後方互換破壊(F9)**、**無断の新規外部依存**。理由を明示する。

**カバレッジ穴の判断ゲート**: カバレッジに穴(縮退レビュー / diffmap 未生成 / 必須 failure-mode 検証の未実施 /
E2E スキップで実機リグレッション未検証)があり、**その穴が PR の変更領域と重なる場合は LGTM を出さない**。
最良でも条件付き(=その領域を人手/再走査で確認、が条件)とする。穴が変更領域と無関係なら判断に影響させない
(過剰ブロックの回避)。

判断は忖度しない。緑なら緑、赤なら赤とはっきり言う。ただし既存コードに元々ある問題は判断材料にしない。

### 4-3. 承認を待つ

サマリー提示後、**ユーザーの指示を待つ**。ユーザーが投稿可否・投稿範囲を決める。
指示が来るまで Phase 5 に進まない。「投稿しない」と言われたら、**1-4 で worktree を撤去**してから完了報告へ進む
(撤去を飛ばして「完了」に直行しない)。

## Phase 5: 承認後の簡潔インライン投稿

ユーザーが「投稿して」(または「High と Middle だけ投稿して」等の範囲指定)と指示したときだけ実行する。

### 5-1. 投稿対象の確定 + 最終ゲート(4 段)

**payload は会話の記憶でなく `/tmp/pr-<PR>-findings.json`(1-2d で永続化)から組む**。承認待ち+E2E で
コンテキストが劣化しても確定 findings が壊れないため。ユーザーの指定に従い投稿対象を絞る。範囲指定が無ければ
既定で **High / Middle / Low** を投稿し **Nit は既定で除外**(明示されたら含める)。`REVIEW`(低確度)も既定で投稿しない。

投稿直前に以下を順に通す(黙って落とさず、除外・降格は件数と理由をユーザーに報告):

1. **head SHA の陳腐化チェック**(rank: push 対策): 現在の `gh pr view <PR> --json headRefOid` を取得し、
   diffmap の `head_sha` と比較。**不一致なら承認待ち中に PR が更新されている** → diffmap を再生成
   (差分が出た path だけ再取得すれば軽い)してから以降のゲートを回す。
2. **diffmap 許可集合との再突合**(422 の最終防波堤): payload の全 `(path, line, side)` を許可集合と突合。
   **複数行範囲は `(path, start_line, start_side)` も必ず突合**(start_line が差分外だとコメント全体が 422)。
   どちらか外れたら単一行 `line` コメントに降格するか、その指摘を除外。
3. **既存コメントとの重複ガード**(rank: 再レビュー対策): `gh api repos/{owner}/{repo}/pulls/{PR}/comments`
   で**自分が過去に投稿した review コメント**を取得し、`(path, line, body 先頭の正規化テキスト)`で突合。
   完全一致・同根(逆引き後の同一 code_anchor)は『既出のため再投稿しない』として除外・件数報告。
   review `body` 冒頭に『N 回目のレビュー(前回 review URL)』を入れ、人間が差分を追えるようにする。
4. **E2E 由来で diff 行に乗らない findings**: inline せず **単発コメント**(`gh pr comment`)に回す(3-4 / gh-inline 参照)。

### 5-2. 簡潔なインラインコメントを投稿

`gh api` で PR review を 1 つ作成し、各指摘を inline comment として一括投稿する。

**コメント本文の必須フォーマット(簡潔さを測定可能なルールに固定する)**:

- **1行=`**[Sev]** <問題>。<修正方針>。`** の形を厳守。`<問題>`(なぜ問題か)と `<修正方針>`(どう直すか)を
  **各1文・合計1〜2文**に圧縮する。冒頭の severity ラベル(`**[High]**`/`**[Middle]**`/`**[Low]**`/`**[Nit]**`)は必須。
- **見出し構造(`## なぜ問題か` / `## どう直すか`)は禁止**。箇条書きの羅列・段落分けの散文も禁止。コメントは1〜2文の地の文だけ。
- **本文は概ね 200 字以内**を目安にする(下記コード片を除く)。超える指摘は、文を削るか、詳細を Phase 4 サマリーの
  `detail` 側に残してコメントには結論だけ載せる。
- **修正案コードは High/Middle で「言葉だけでは直し方が一意に伝わらない」時のみ**、1〜3 行のコードフェンスを添える
  (例: `if r == nil { return ErrNotFound }`)。Low/Nit にコードフェンスは付けない。コードの前後に解説の散文を足さない。
- **悪い例**(長すぎ): `## なぜ問題か\nこの関数は report_id が null の場合に...(数段落)...\n## どう直すか\nまず...次に...`。
  **良い例**: ``**[High]** `report_id` が null の時 panic する。handler 先頭に `if r == nil { return ErrNotFound }` を追加。``

review の `body`(全体サマリ)も同様に簡潔に — Phase 4 の「最終判断(LGTM/条件付き/非推奨)」とテスト結果を数行で。
指摘の詳細を body に再掲しない(各 inline コメントに書いてある)。

詳細な API の使い方・ペイロード形式・既知の落とし穴は `references/gh-inline-review.md` を読むこと。
要点:

- エンドポイントは `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`
- `comments` 配列に `{path, line, side:"RIGHT", body}` を並べる。`event` は `COMMENT`
- review の `body` には Phase 4 の「最終判断」と「テスト結果」を簡潔に載せる
- **メモリの教訓**: `requested_reviewers` 系 REST は 422 で弾かれるが、**review 作成 API は別物**で
  正常に動く。`line` は diff の RIGHT 側に実在する行のみ(差分外は 422)

投稿後、review の `html_url` をユーザーに提示する。

## 完了報告

**報告の前に `git worktree list` を実行し、1-0 で作った `kozoka-v2r-prreview-*` が残っていないことを確認する**
(1-4 で撤去済みのはず。取り残しがあれば `git worktree remove --force` + `git worktree prune` で掃除してから報告)。
worktree を残したまま完了報告するのは禁止 — 対象ブランチを占有し、別セッション・devcontainer がそのブランチを使えなくなる。

最後に次を報告する:

- 最終 merge 判断(LGTM / 条件付き / 非推奨)
- (投稿した場合)レビュー URL と投稿した指摘の内訳、(しなかった場合)その旨
- E2E で通った/落ちたシナリオ
- worktree を撤去済みであること(`git worktree list` がクリーン)
- 残課題と次にやるべきこと

CLAUDE.md の回答フォーマット(「## 今回の知見とルール更新提案」+ コミットメッセージ)に従う。

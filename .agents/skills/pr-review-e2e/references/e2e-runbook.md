# E2E ランブック(Phase 2-3)

pr-review-e2e の Phase 2(devcontainer サーバ起動の橋渡し)と Phase 3(ブラウザ E2E)の詳細手順。
静的レビュー(Phase 1)が終わり、実機リグレッション検証に進むときに参照する。

**環境境界(再掲)**: Ghostty(ホスト)では `pnpm dev` / `pnpm install` 禁止。E2E は人間が devcontainer で
サーバを起動した後、Claude in Chrome 経由で行う。Claude in Chrome が使えない場合は `agent-browser`
スキルにフォールバック(理由を Phase 4 カバレッジ欄に明記)。

---

## Phase 2: devcontainer サーバ起動の橋渡し

**前提: Phase 1 の worktree(1-0)を撤去してから checkout する**(SKILL.md 1-4)。E2E はメインレポを
`git checkout` するため、同一ブランチを worktree が占有したままだと二重チェックアウトで失敗する。撤去は
**2-1 で切替承認を得た後・`git checkout` の直前**に行う(承認前には撤去しない。拒否/スキップなら worktree を
残し Phase 4 へ戻る)。撤去手順: `rm -f .../frontend/node_modules`(symlink を先に外す)→
`git worktree remove ../kozoka-v2r-prreview-<PR>` → `git worktree prune`。

役割分担を明確に分ける:

- **ブランチ切替はホスト(このセッション)側で行う** — `git checkout <headRefName>` を Ghostty で実行する。
  全ターミナルタブは同一 git リポジトリを共有する(CLAUDE.md の鉄則)ため、ホストで切り替えれば
  devcontainer 側も自動的に同じブランチを見る。devcontainer 側で checkout させてはならない —
  ユーザーが別ブランチ(例: 別 Issue の作業ブランチ)のまま再起動してしまう事故が起きやすい。
- **dev server 起動はユーザーが devcontainer 側で行う** — `pnpm dev` / `make run-dev` は devcontainer
  でのみ。Ghostty で叩くと OOM や native binding 上書きで壊れる。

**重要: ブランチ切替の前に必ずユーザーの承認を取る。** ホストでの `git checkout` は、全ターミナルタブと
devcontainer 側のブランチを巻き込んで切り替える**破壊的操作**である。ユーザーが別ブランチで並行作業
(別 Issue の実装・デバッグ・別の devcontainer セッション等)をしている最中に勝手に切り替えると、その
作業を中断・破壊しかねない。E2E は「あると望ましい」検証であって、ユーザーの進行中作業を犠牲にして
まで強行するものではない。切替が並行作業に影響し得る旨を伝え、承認を得てから 2-1 を実行する。
承認が得られない/今は切り替えたくない場合は、E2E をスキップし静的レビュー + テスト結果だけで
Phase 4 のサマリーに進む(その旨をサマリーに明記する)。

### 2-1. ホスト側でブランチを切り替える(承認を得てからこのセッションで実行)

まず現在地と作業状態を確認し、**切替してよいかユーザーに確認する**:

```bash
git branch --show-current                          # 現在地を控える(切替で巻き込む元ブランチ)
git status --short                                 # 未コミット変更の有無
```

そのうえでユーザーに承認を求める。確認は具体的に。例:
「E2E のためにメインレポを現在の `<現在ブランチ>` から `<headRefName>` に切り替えます。これは全
ターミナルタブと devcontainer 側のブランチも巻き込んで切り替わるため、別ブランチで並行作業をして
いると影響します。切り替えてよいですか?(今は切り替えたくない場合は E2E をスキップして静的レビュー
結果だけでサマリーを出します)」

未コミット変更がある場合は、それが切替で失われない(別ブランチに持ち越される)旨も含めて、どう
扱うかをユーザーに委ねる。**承認が得られたら**、まず Phase 1 の worktree を撤去(同一ブランチの二重
チェックアウト回避)してから安全に切り替える:

```bash
rm -f ../kozoka-v2r-prreview-<PR>/frontend/node_modules   # 借りた symlink を先に外す
git worktree remove ../kozoka-v2r-prreview-<PR>; git worktree prune  # Phase 1 worktree を撤去
git grep -l -e '^<<<<<<< ' -e '^>>>>>>> ' || true  # コンフリクトマーカー残存の検出
git fetch origin <headRefName>                     # リモート最新を取得
git checkout <headRefName>
git rev-parse HEAD; git rev-parse origin/<headRefName>  # ローカル=リモート一致を確認
```

切替後、frontend にコンフリクトマーカーが無いこと（`git grep` がクリーン）を必ず確認する。
**Build Error の典型原因は「別ブランチに残った `<<<<<<< HEAD` マーカー」** であり、これは
正しいブランチへ切り替えるだけで消えることが多い（実運用で確認済み）。

### 2-2. ユーザーに dev server 再起動を依頼して待機する

ホスト切替だけでは **devcontainer の dev server プロセスは古いコードを掴んだまま**。ユーザーに依頼:

1. **backend を再起動**(`make run-dev` を Ctrl+C → 再実行)
   - 重要: `git checkout` してもビルド済み Go バイナリは古いまま動く。再起動しないと
     この PR のロジックが反映されず E2E が無意味になる。
   - 再起動後、ターミナルのプロンプトのブランチ名が `<headRefName>` であることを目視確認してもらう。
     別ブランチ名のままなら、ホスト切替が devcontainer に伝わっていない（要調査）。
2. **frontend dev server を再起動**(`rm -rf frontend/.next` で Turbopack stale chunk を一掃 → `pnpm dev`)
3. 立ち上がったら「準備できた」と合図してもらう

ユーザーへの依頼は具体的に。例:
「メインレポを `<headRefName>` に切り替えました。devcontainer で backend を再起動(古いバイナリが
残るため必須)、`frontend/.next` を消して frontend dev server を再起動してください。立ち上がったら
合図をください。Claude in Chrome で E2E を始めます。」

合図が来るまで Phase 3 に進まない。

### 2-3. Phase 3 冒頭で「正しいブランチで起動しているか」を必ず確認

合図を受けても、いきなり機能テストに入らない。**最初に「対象 PR のコードが本当に動いているか」を
検証する**。具体的には、この PR が触ったページ/画面を 1 つ開き、Build Error が出ないこと・
想定の挙動になることを確認してから本シナリオへ進む。ここを飛ばすと、別ブランチで E2E を回して
「問題なし」と誤報告する事故になる（実運用で発生）。

---

## Phase 3: Claude in Chrome(または agent-browser)で包括的 E2E テスト

合図を受けたら Claude in Chrome のブラウザ自動化で E2E を行う。Claude in Chrome が使えない場合は
`agent-browser` スキルにフォールバックする。テストシナリオ・観点・merge 判断の進め方は手段に依らず同一。
以下 3-1/3-3 は Claude in Chrome を前提に書くが、agent-browser 利用時の読み替えは各所に併記する。

### 3-1. セッション開始の作法

ブラウザツールは ToolSearch で読み込んでから使う(MCP の遅延ツール)。最初に
`mcp__claude-in-chrome__tabs_context_mcp` で現在のタブ状況を取得し、原則**新規タブ**を作って作業する。
既存タブの再利用はユーザーが明示した場合のみ。

**agent-browser にフォールバックする場合**: ToolSearch でブラウザツールが見つからない、
`tabs_context_mcp` がエラーを返す、または拡張が応答しないと判断したら、`agent-browser` スキルへ切り替える。
基本ワークフローは `open <url>`(ページ遷移)→ `snapshot -i`(`@e1`/`@e2` の ref 付き対話要素を取得)→
`click @e1` / `fill @e2 "text"`(ref で操作)→ ページ変化のたびに再 `snapshot`。
コマンド一覧は `agent-browser --help` で確認できる。GIF 記録やコンソール/ネットワーク確認の
代替手段(スクリーンショット・ログ確認コマンド)も `--help` で把握し、取れるエビデンスの範囲を
Phase 4 のサマリーに正直に記す。

### 3-2. テストシナリオの組み立て

Phase 1 の「E2E で検証すべきリグレッション懸念」を起点に、次をカバーする:

- **正常系**: この PR が追加/変更した機能が意図通り動くか
- **リグレッション系**: 変更が触った共有部分に依存する**既存機能**が壊れていないか
- **権限分岐**: 管理者/非管理者で挙動が変わる機能なら**両アカウントで**確認する
  (テスト用アカウント・team_id はプロジェクトのメモリ/設定を参照)

### 3-3. 実行とエビデンス

各シナリオを実行し、重要な手順は GIF 記録(`gif_creator`)で残す。前後に余分なフレームを
取り、意味のあるファイル名(例 `pr<番号>_<機能>_e2e.gif`)を付ける。

挙動が想定と違う場合、まず Network の Initiator と console ログ(`read_console_messages`、
必要なら `pattern` で絞る)を確認する。RSC 無限ループ(`GET /?_rsc=` 連打)や polling 停止は
このプロジェクトの典型的な失敗モードなので疑う(SKILL.md の F2/F3)。

**ダイアログ厳禁**: alert/confirm/prompt を発火させる操作(削除確認等)は避ける。発火すると
拡張が応答不能になる。やむを得ない場合はユーザーに警告してから行う。

ブラウザ操作が 2〜3 回失敗したら、深追いせずユーザーに状況を報告して指示を仰ぐ。

### 3-4. E2E 結果を蓄積(投稿しない)

E2E の結果(通った/落ちたシナリオ、再現手順、エビデンス GIF への参照、検知したリグレッション)を
**蓄積する**。ここでは投稿しない。E2E で新たに見つかったリグレッションは、Phase 1 の指摘リストに
直接足さず、**SKILL.md 1-2c の批判検証3チェックと 1-2d の集約を同じく通す**(検証済=Phase1産 /
未検証=Phase3産 という二系統混在を避け、サマリーの一貫性を保つため)。実機で壊れている分、検証は KEEP に
倒れやすいが、「既存コード由来でないか」「この PR の変更が原因か」は必ず確認する(通常 High か Middle)。

# E2E runbook

UIまたは実行時挙動がレビューの主要リスクで、静的解析とunit/integration testだけでは判断できない場合に使う。

## 目次

1. 実行判断
2. 環境準備
3. devcontainerの承認ゲート
4. Scenario設計
5. 実行と証拠
6. Finding化

## 1. 実行判断

E2EはSKILL.mdのPhase 7で、レビュー提示と投稿のあとに行う任意の工程である。必須ではないが、推奨 / 任意 / 不要の判断と根拠は必ずユーザーへ提示し、実行するかはユーザーが決める。

次のいずれかならE2Eを検討する。

- user flow、routing、form、browser state、accessibility、responsive behaviorの変更
- auth/role/tenant/feature flagによる実行時分岐
- polling、websocket、cache、race、background job連携
- public APIとclientのintegration
- PR本文がE2Eまで明示的に要求する

docs-only、内部refactor、静的に十分検証できる変更では、E2Eを儀式的に実行しない。

### E2E実行の承認

E2Eを実行すると判断したら、環境変更やserver起動の前に次をユーザーへ提示する。

- E2Eが必要な理由と、静的解析・unit/integration testだけでは残るrisk
- base/head SHA、検証するscenarioと期待結果
- 使用する環境、commandまたはbrowser手段、想定時間
- test data、外部通信、課金、通知、永続dataなどの副作用
- devcontainerかどうかと、メインリポジトリ切替の要否

`上記の対象SHAとscenarioでE2Eを実行してよいですか？`と明示的に確認し、回答を待つ。PRレビュー依頼をE2E承認として扱わない。拒否または明示承認がない場合は実行せず、理由付きのcoverage gapとして静的レビューを継続する。

この承認はE2E実行だけを許可する。メインリポジトリ切替、devcontainer rebuild、破壊的なfixture、GitHub投稿には、それぞれ別の承認を得る。

## 2. 環境準備

`repository-adaptation.md` のreview profileから、正準の起動方法、E2E framework、base URL、fixtureを選ぶ。

- 既存作業ツリーやユーザーのdev serverを勝手に切り替えない
- 可能ならdetached worktree、ephemeral container、preview environmentを使う
- productionや実ユーザーデータへ接続しない
- test account、seed、mock serviceを使う
- 課金、メール送信、外部通知、削除など副作用のある操作は明示的な許可を得る
- fork PRへsecretを渡さない

環境起動をユーザーが担当する必要がある場合は、必要なbranch/SHA、正準コマンド、再起動理由、準備完了条件を具体的に伝えて待つ。

## 3. devcontainerの承認ゲート

devcontainer内のserverがbind mountされたメインリポジトリだけを参照し、detached worktree、ephemeral container、preview environmentからE2Eできない場合に限り、この例外ゲートを使う。単に`.devcontainer/`が存在するだけでメインリポジトリの切替が必要だと推測しない。

### 3.1 承認前preflight

メインリポジトリを変更する前に、read-onlyで次を取得する。

```bash
git -C <MAIN_REPO_PATH> rev-parse --show-toplevel
git -C <MAIN_REPO_PATH> branch --show-current
git -C <MAIN_REPO_PATH> rev-parse HEAD
git -C <MAIN_REPO_PATH> status --porcelain=v2 --branch --untracked-files=all
git -C <MAIN_REPO_PATH> worktree list --porcelain
```

PR metadataからbase branch/SHA、head branch/SHAも取得し、E2E成果物を対象head SHAへ束縛する。base/head比較を行う場合は、比較に使う両SHAを固定する。

`git -C <MAIN_REPO_PATH> status`にtrackedまたはuntrackedの変更がある場合は、そこで停止する。自動`stash`、`reset`、`clean`、`switch`、`checkout`を行わず、ユーザーに変更を保存して作業ツリーをcleanにするか、E2Eを省略するかを選んでもらう。未コミット変更をPR側へ持ち越した状態のE2Eは、対象SHAの検証として扱わない。

作業ツリーがcleanなら、次を1つの実行計画としてユーザーへ提示する。

- repositoryの絶対path
- 現在branchまたはdetached状態と現在SHA
- PRのbase branch/SHAとhead branch/SHA
- dirty stateと他worktreeの状態
- 同じメインリポジトリを参照するterminal、IDE、agent、watcher、serverへの影響
- 停止するserver、所有者、port、停止・起動・health check方法
- `server停止 -> 対象SHAへswitch -> 依存準備 -> server再起動 -> E2E -> server停止 -> 元branch/SHAへ復元 -> 必要な依存復元 -> 元server再起動 -> health check` の全手順
- base/head比較を行う場合は、同じfixtureとscenarioで両SHAを検証する順序
- 想定停止時間、永続dataや外部serviceへの副作用、復旧条件

E2E実行の承認を得ていても、次のようにメインリポジトリ切替への別の明示承認を求めて待つ。PRレビュー依頼やGitHubへのレビュー投稿承認を、メインリポジトリ切替の承認として扱わない。反対に、切替承認もGitHub投稿の承認を意味しない。

```text
承認済みのdevcontainer E2Eを行うには、メインリポジトリを
<current-branch>@<current-sha> から <head-branch>@<head-sha> へ一時的に切り替える必要があります。
上記の影響範囲、server再起動、検証手順、復旧手順を含む一時切替を行ってよいですか？
```

拒否または明示承認がない場合は切り替えない。E2Eをskipし、`未実施（devcontainerのメインリポジトリ切替が未承認）`としてcoverage gapへ記録する。静的レビュー、既存CI、detached worktreeで可能なbuild/unit/integration testは継続する。

### 3.2 承認後の再検査

承認後、server停止やbranch切替の前にpreflightとPR metadata取得をもう一度行う。現在branch、現在SHA、dirty state、worktree構成、base/head SHAのいずれかが承認時から変わっていたら、古い承認を使わない。変更後の実行計画を提示し、再承認を得る。

同じメインリポジトリを使う全sessionが停止または影響を了承したことを確認する。ユーザーまたは所有者不明のserverを自動停止しない。ユーザーへ停止と準備完了の確認を依頼する。agentが起動したserverは、広い`pkill`ではなく記録したserviceまたはPIDだけを停止する。

running serverを停止してから対象SHAへ切り替え、正準の依存準備だけを行う。lockfile差分がある場合はfrozen/locked installを使い、元branchへ戻した後の依存復元も計画に含める。PRが`.devcontainer/`を変更しcontainer rebuildが必要な場合は、この承認へ含めず、影響を説明して別の明示承認を得る。

### 3.3 必須復元処理

E2Eの成功、失敗、timeout、中断にかかわらず、`finally`相当の処理として次を行う。

1. 対象SHA用に起動したserverを停止する。
2. E2Eが想定外のtracked/untracked変更を生成していないか確認する。見つかった場合は`reset`や`clean`で消さず、復元を妨げる内容をユーザーへ報告する。
3. 安全に切替可能なら、記録した元branchへ戻す。開始時がdetachedなら記録した元SHAへ戻す。force checkoutは行わない。
4. 計画に含めた依存復元を行う。
5. 開始前に動いていたserverだけを再起動する。ユーザー所有serverはユーザーへ再起動を依頼する。
6. 正準のhealth checkを行う。
7. branch、HEAD SHA、`git -C <MAIN_REPO_PATH> status --porcelain=v2 --branch --untracked-files=all`が開始前のsnapshotと一致することを確認する。

別sessionによる変更や生成物で安全に復元できない場合は、強制操作で合わせない。現在状態、復元できた範囲、必要なユーザー操作を直ちに報告し、E2E結果にも環境復元の失敗を明記する。

## 4. Scenario設計

change mapと静的review候補から、最小のscenario matrixを作る。

| Scenario | 発火条件 | 期待結果 | 証拠 |
|---|---|---|---|
| normal | 主要変更 | acceptance criteriaを満たす | screenshot/log |
| boundary | null/empty/max/min/error | 明示されたerror/empty state | screenshot/network |
| permission | role/auth変更 | 許可/拒否が正しい | status/UI |
| regression | shared dependency変更 | 既存consumerが維持される | before/after |
| co-mount | 追加した共有部品が2箇所以上で同時に実体化 | 識別子衝突や相互干渉が起きない | DOM/UI/network |
| recovery | retry/offline/timeout | 二重処理やsilent failureなし | network/log |

すべてを機械的に実行せず、変更に関係する行だけ選ぶ。破壊的操作は避けるか、隔離fixtureで行う。新規の共有componentが複数導線で使われる場合は、単一導線だけを叩いて完了とせず、それらが同時に描画・実体化される状態を最低1つ検証する。都合で単一導線しか叩けない場合は、未検証の同時実体化状態をcoverage gapへ明記する。

## 5. 実行と証拠

利用可能な手段を次の順で選ぶ。

1. リポジトリ既存のE2E suite
2. in-app browserまたは利用可能なbrowser automation
3. preview environmentのmanual smoke
4. ユーザーが実行し、ログ・動画・screenshotを共有

ページ遷移や状態変化のたびにDOM/snapshotを更新する。見た目だけで成功判定せず、必要に応じてconsole、network status、request payload、server logを確認する。secret、token、PIIを証拠へ含めない。

回帰やPR帰属をE2Eで確認する場合は、固定したbase/head SHAに対して同じfixture、入力、browser条件、scenarioを使う。headだけで失敗したことを確認し、環境差をPR findingとして扱わない。baseを実行できない場合は比較不能としてcoverage gapへ残す。

失敗時は次を分離する。

- product failure: PRコードが原因
- test failure: selector、fixture、assertionの問題
- environment failure: server、dependency、credential、network不足
- inconclusive: 再現条件または仕様不足

同じ操作を無制限に再試行しない。2〜3回で原因を切り分けられなければ、未検証として報告する。

## 6. Finding化

E2Eで症状を観測しても、直ちにPR findingへしない。

1. baseまたは既存挙動との差を確認する。
2. このPRの変更へ因果を結び付ける。
3. 実行手順、期待、実際、環境、証拠を記録する。
4. `review-rubric.md` の反証条件を通す。
5. 原因となる変更行が確定すればinline候補にする。
6. 原因行がdiff外または不明なら、承認後の単発PRコメント候補にする。

E2E未実施や環境失敗を「テスト成功」と書かない。重要なruntime riskと重なる場合はmerge判断を条件付きにする。

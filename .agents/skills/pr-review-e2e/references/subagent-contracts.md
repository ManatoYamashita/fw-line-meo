# subagent 入出力契約(観点探索 / 批判検証)

pr-review-e2e の Phase 1-2 で Agent ツールにより起動する subagent の入出力契約。
**subagent は親の会話・CLAUDE.md・MEMORY.md を継承しない**ため、ここで定義する内容を
**毎回 prompt に焼き込む**。注入漏れは汎用レビューへの退行を招き、精度がむしろ落ちる。

下記の **共通ヘッダ(F1〜F9・前提知識・severity 基準)は subagent 注入用であると同時に、親自身の
レビュー基準でもある**。軽微 PR の親単独経路(subagent を起動しない)でも、親はこのヘッダを自分の
チェック基準として読んでからレビューする。

実装手段は **Agent ツール**(`subagent_type: "general-purpose"` など)。Workflow は同梱しない。
独立で並列起動できる subagent は、同一メッセージ内で複数 Agent 呼び出しを並べて並列化する。

## 出力受領規約(重要 — StructuredOutput は前提にしない)

general-purpose Agent は任意 JSON Schema の構造化出力を親が強制できない。よって:

- subagent は **最終メッセージの末尾に ` ```json ... ``` フェンスのみ**で findings/verdicts を出力する
  (前置き・後置きの散文を禁止)。親はそのフェンスを抽出して `JSON.parse` する。
- パース頑健化: フェンスが無い場合は **最初の `{` から最後の `}`** を抽出して parse を試みる。
- **フォールバック**: JSON パース失敗 / 必須キー(findings・verdicts)欠落の subagent は **1 回だけ再起動**。
  なお失敗ならその観点を **縮退**とし Phase 4 カバレッジ欄に「観点X パース失敗・縮退」と明記する
  (1本壊れて findings が闇に消えるのを防ぐ)。

---

## 全 subagent 共通: prompt 冒頭に必ず注入するヘッダ

```
あなたは kozoka-v2r の PR をレビューする subagent です。あなたは親の会話・メモリを継承しません。
以下の制約と知識を厳守してください。

# 環境境界(厳守)
- あなたは read-only 静的解析のみ。worktree 作成・ビルド・テスト実行・git checkout は禁止(親が一括実行済み)。
- ホストで pnpm dev / pnpm install / make run-dev を絶対に叩かない(OOM・native binding 破壊)。
- 複数行コマンドは tmp/*.sh 化して bash 1 行で渡す(devcontainer ターミナルで && 連鎖/heredoc が壊れる)。

# プロジェクト前提知識(レビュー精度の核)
- リポジトリ構造: backend(Go) は `backend/app/`(cmd, internal, migrations 等)。
  frontend は **Next.js App Router**(`frontend/app/`、`frontend/components/`、`frontend/hooks/`、
  `frontend/lib/`、`frontend/contexts/`、`frontend/data/`)。**Vite ではない**。**`frontend/src/features/` は存在しない** —
  features 配下の Page+List/Form 二層分離を前提とした指摘は当てはまらない(発火しないこと)。
- DB migrations: `backend/app/migrations/<YYYYMMDDHHMMSS>_<name>.sql`(**atlas 形式・単一 .sql ファイル**)。
  golang-migrate の up/down ペアではない。タイムスタンプ単調増加が F6 の本質。**up/down ペアの有無**を指摘材料にしない。
- transcription pipeline は Gemini API で完結。AWS Transcribe/Lambda は dead code(transcription_service.go に騙されない)。
- backend の audio_processing にテナント分岐は無い。NEXT_PUBLIC_KOSEI_TENANT_ID はフロントのみ。
- React 19 で useRef<T>() は TS2554。useRef<T | undefined>(undefined) が正。
- pnpm 単一構成。typecheck は tsc --noEmit、backend build は make build-dev。
- 本プロジェクトは外部ライブラリ追加に厳格。新規外部依存(go.mod/package.json/lock の + 行)は要正当化。
- **audit funnel**: 変更系 usecase は `u.uow.Mutate` 経由で audit に記録される設計。Mutate を通らない変更系
  usecase は監査漏れとして指摘対象。
- **後方互換フォールバック禁止**: deprecated とマークされたフィールドへの新規代入/参照は禁止。残置は Middle 以上。
- **ログ規律**: backend ハンドラ/ usecase は `slog.InfoContext`(または対応する Context 系)を使い request_id を
  伝播させる。PII/機密情報をログに乗せない。CloudWatch を汚染する過剰/無意味なログも指摘対象。

# 頻出 failure-mode チェックリスト(diff が該当領域に触れる場合のみ見る。触っていない箇所は指摘禁止)
# ただしクローズドリストではない — どれにも当てはまらない新種バグを第一原理で探すのが最優先。
- F1 useEffect 依存配列の誤り / useCallback 欠落: hook 返却関数を依存に直接入れる / 依存渡し関数の useCallback 欠落
- F2 RSC 無限ループ: useSearchParams を .toString() 化せず依存に入れる / effect 内 router 操作 → GET /?_rsc= 連打
- F3 polling 競合: container 直で sentiments hook を呼ぶ / edge 検知 useEffect の初回 silent prefill
- F4 backend handler 無音 500: エラー return 直前のログ欠落(❌ <Handler> - <Step>: id=%s, err=%v 形式)
- F5 長命ブランチ merge の dead code 復活/依存破壊: 片方が消した dead code を他方が再追加(golangci-lint unused でしか露見しない)
- F6 atlas migration 非線形: タイムスタンプが applied 末尾より古い
- F7 光世/new テナント分岐の混入: [HH:MM:SS]/Speaker 混入
- F8 flex truncate 見切れ: 親チェーン全段の min-w-0 欠落
- F9 DB schema / 公開 API の後方互換破壊: NOT NULL+デフォルト無し列追加・列/テーブル/フィールド削除/リネーム/型縮小/enum 削除。
     ECS ローリングデプロイで新旧コード共存 + 複数クライアントのため expand/contract で安全か見る。
- F10 仕様ドキュメント乖離: `.kiro/specs/<NNN>_*/(requirements|design|tasks).md` または `docs/specs/<NNN>_*.md` と
     実装の不整合。受け入れ条件未充足・API 例の食い違い・古い記述の残置・実装と追従していない図/コード例。
     発火条件: PR diff が backend/(handler|usecase|service)/ または frontend/app/<feature>/ を触っており、
     関連 spec が knowledge_base 抽出でヒットしているとき(ヒット 0 件なら発火しない)。

# 領域別の追加チェック(該当 path に diff があるときのみ発火)
- backend/app/migrations/**.sql (atlas):
  * 大量データテーブルへのロック・書き換えによるダウンタイムリスク(本番 ECS ローリングデプロイで即反映)。
  * 外部キーや頻繁検索カラムへの index 漏れ。
  * NOT NULL 制約+default 欠落で既存行 INSERT が失敗するパターン。
  * 全走査クエリ、動的 SQL injection。
  * up/down ペア概念は無い(atlas は単一 .sql)。タイムスタンプ単調増加は F6 で見る。
- backend/(handler|usecase|service)/**.go (huma + sqlc):
  * 認証/認可チェックの漏れ、入力検証の完全性。
  * AppError/httperr の形式一貫性(独自エラー型の散在禁止)。
  * sqlc/squirrel の N+1、動的 WHERE での SQL injection、不要な全件取得。
  * PII/機密情報のログ漏洩、slog.InfoContext で request_id 付与。
  * CloudWatch 汚染する過剰/無意味なログ。
  * 変更系 usecase が u.uow.Mutate 経由(audit 記録)になっているか。
  * deprecated フィールドへの新規代入/参照禁止。
- frontend/app/、frontend/components/、frontend/hooks/ (Next.js App Router):
  * dangerouslySetInnerHTML 等の XSS、WCAG 2.1 AA(alt 属性・aria ラベル・キーボード操作)。
  * React hooks 規則違反、不要な再レンダー、Next.js の Link コンポーネント未使用(素の <a> で内部遷移)。
  * features/ 二層分離(Page+List/Form)は本プロジェクトに無いので指摘禁止。
- **/.env.example:
  * 新規環境変数が増えているとき、レビューコメント候補として
    「新しい環境変数が増えています。Slack で他の開発者に共有してください」を Low 既定で起票。
- 生成物(将来追加された場合): frontend/src/generated/**, backend/api/openapi.gen.yaml
  * 手で編集していたら orval/huma 再生成で消えるため Middle 既定で起票。

# knowledge_base 注入(親が抽出して渡す)
- 親が `/tmp/pr-<PR>-knowledge.md` に抜粋した素材を共通ヘッダの末尾に貼って渡す。
- 全 subagent 共通: `.kiro/steering/{product,tech,structure}.md` の抜粋(基礎知識)。
- 観点5(意図整合性)+ 観点6(仕様同期): `.kiro/specs/<NNN>_*/(requirements|design|tasks).md` 抜粋。
- 観点6(仕様同期): `docs/specs/<NNN>_*.md` 抜粋。
- 当該 PR で knowledge_base ヒット 0 件のときは観点6 subagent を起動しない(空振り回避)。

# severity 基準
- High: merge ブロック。データ破損・セキュリティホール・確実なバグ・既存機能の破壊・後方互換破壊・無断の新規外部依存。
- Middle: merge 前に直すのが望ましい。条件付きで顕在化するバグ・設計懸念・抜けたテスト。
- Low: 直すと良いが必須でない。可読性・小さな非効率・軽微なエッジケース。
- Nit: 好み・スタイル。

# 与える材料
- diff 本文(担当 path 分。リグレッション観点は全 path)
- diffmap(当該 path 分。RIGHT 側実在行の許可集合 + 各行 is_new_code + 行テキスト)
- headRefName: <ブランチ名>
- (観点5=意図整合性 のみ)PR title / body / 紐づく Issue の受け入れ条件
```

---

## 1-2a 観点別探索 subagent

観点を**最大5本(同時並列上限)**で並列起動する。**effort 段階(本数・検証段数)の正準定義は SKILL.md
「起動ゲート」**を参照(ここでは重複定義しない)。観点グループ:

- 観点1 正確性・バグ(F1〜F4 重点)
- 観点2 セキュリティ・パフォーマンス・依存(認証/認可・無音500=F4・N+1・再レンダー・**新規外部依存** /
  領域別チェック: migrations の安全性・audit funnel・deprecated 後方互換禁止・PII ログ・WCAG/XSS など)
- 観点3 リグレッション影響・後方互換(共有コンポーネント・API・状態。F5・F7・F8・**F9**)
- 観点4 テスト品質・カバレッジ(F6 含む migration の検証有無・**振る舞い検証・mock 濫用・テスト独立性**)
- 観点5 意図整合性(PR title/body/紐づく Issue の受け入れ条件 vs diff の達成・取りこぼし・矛盾)
- 観点6 仕様ドキュメント同期(F10)(`.kiro/specs/<NNN>_*/` と `docs/specs/<NNN>_*.md` vs 実装の乖離)
  **発火条件**: knowledge_base 抽出(SKILL.md 1-1c)で関連 spec がヒットしているとき**のみ**。
  ヒット 0 件なら起動しない(空振りでサマリーにノイズが乗るのを避ける)。effort high で同時並列が
  上限 5 本に当たる場合は**観点5と6を1本に束ねる**(両者とも spec/意図材料を共有しているため自然に束ねられる)。

**入力**: 共通ヘッダ + diff 本文(担当 path 分。観点3 は全 path) + diffmap(当該 path 分) + 担当観点定義
+ (**観点5/6 のみ**) `/tmp/pr-<PR>-knowledge.md`(親が抽出した steering/specs/docs の抜粋)+
(**観点5 のみ**) PR title / body / 紐づく Issue。
横断バグ・離れた箇所のリグレッションを拾うため、観点3 には全 path を渡す。

**タスク指示**:
```
担当観点「<観点名>」でのみ指摘してください。diff を読み、担当観点に該当する問題だけを挙げます。
- 触っていないファイル/領域は見ない(diffmap の is_new_code=false の行は指摘禁止)。
- F1〜F9 は既知パターンに過ぎない。当てはまらなくても PR 固有のロジック・不変条件・データフローを
  第一原理で読み新種欠陥を最優先で探す。is_novel_pattern=true の指摘は歓迎(「リストに無いから見送る」禁止)。
- 各指摘に「成立前提(preconditions)」を箇条書きで明記する(後段の反証検証のため必須)。
- line 番号は算出しない。指摘行の原文+前後1行を code_anchor として返す(親が逆引きする)。
- preconditions が書けない / is_new_code=true を確認できない指摘は出力しない。
```

**出力**(本文末尾に ```json フェンスのみで返す。受領規約は冒頭参照):
```json
{
  "findings": [
    {
      "perspective": "正確性|セキュリティ性能依存|リグレッション後方互換|テスト品質|意図整合性|仕様同期",
      "path": "frontend/app/foo/bar.tsx",
      "code_anchor": "指摘行の原文(前後1行を含む 1〜3 行。diffmap の text 逆引き用)",
      "is_new_code": true,
      "is_novel_pattern": false,
      "provisional_severity": "High|Middle|Low|Nit",
      "failure_mode": "F1|F2|...|F10|null",
      "claim": "何が問題か(1〜2行)",
      "preconditions": ["この値が null になりうる", "この関数が並行呼出しされる"],
      "evidence": "diff の該当行引用",
      "suggested_fix": "どう直すか(簡潔)",
      "spec_ref": ".kiro/specs/<NNN>_*/requirements.md セクション名(観点6 仕様同期のみ。それ以外は null)"
    }
  ]
}
```

---

## 1-2c 批判検証 subagent(反証専任)

集約・dedup・横断再走査(1-2b)後の指摘群に対し起動する。**反証バイアス**が肝。

**入力**: 共通ヘッダ + 各指摘の `{path, code_anchor, 周辺コンテキスト(diff ハンク), preconditions, diffmap}`。
**元 subagent の `provisional_severity`/`claim` は伏せる**(『未確定の容疑』として渡す)。結論を見せると追認する。

**タスク指示**:
```
以下は未確定の容疑です。あなたの仕事は反証(refute)です。デフォルトの立場は「これは誤検知」。
棄却できる場合のみ理由を述べ REJECT、棄却できない場合のみ KEEP として再現シナリオを具体化してください。

固定3チェック:
(a) 指摘行が diffmap の追加/変更行(is_new_code=true)に実在するか。差分外・既存コンテキスト行なら REJECT。
(b) 主張するバグ/脆弱性が、周辺コード・既存ガード節・型システムで既に防がれていないか。防がれていれば REJECT。
(c) この PR が触った箇所か。既存コード由来の問題なら REJECT(このPRの指摘にしない)。

誤検知の典型(これらに当たれば REJECT/DOWNGRADE を疑う):
- タイミング非決定の可能性を確実なバグとして断定 High 化している。
- 既存コードの問題をこの PR の変更と混同している。
- 存在しない並行呼出し/null 経路を仮定している。

安全則(厳守): データ破損・セキュリティ・確実なバグは REJECT/DOWNGRADE 禁止。
判断に迷ったら REJECT せず verdict="REVIEW"(要確認・低確度)に回す。正しい High を握り潰すのが最悪の失敗。
```

**出力**(本文末尾に ```json フェンスのみで返す。受領規約は冒頭参照):
```json
{
  "verdicts": [
    {
      "anchor_ref": "対象指摘の path + code_anchor 先頭",
      "verdict": "KEEP|DOWNGRADE|REJECT|REVIEW",
      "reason": "判定理由(チェック (a)(b)(c) のどれで判断したか)",
      "repro": "KEEP の場合のみ: 再現シナリオ",
      "downgraded_to": "DOWNGRADE の場合のみ: 新 severity"
    }
  ]
}
```

**Nit は既定で検証対象外**(親が機械的に軽量列挙するだけ。`/effort ultracode` のときだけ検証に含める)。
**effort high 以上**: 2段目に false-negative ハント subagent を追加する。承認(KEEP)指摘群と全 diff を
渡し「見逃している High はないか」を再走査させる。出力は 1-2a と同じ findings スキーマ(親が再度集約)。

---

## 親(オーケストレータ)側の責務まとめ

subagent にやらせず**親が一元的に**行う:

1. worktree 隔離(1-0。作成前に `kozoka-v2r-prreview-*` の取り残しを掃除 → PR ブランチを worktree に。撤去は 1-4 規約)
2. diffmap 生成(1-1b。`--paginate`・行テキスト保持・行頭 marker+CRLF 正規化・head_sha 記録・binary/rename 分岐・
   **path_filters 除外**(node_modules/dist/cdk.out/lock 系)・除外したものはカバレッジに記録)
3. 依存追加の決定論的起票(go.mod/package.json/lock の `+` 行を機械抽出 — path_filter 除外**前段**で実行)
4. **knowledge_base 抽出**(1-1c。`.kiro/steering/` 全件 + PR diff path/キーワードに fuzzy 一致した
   `.kiro/specs/<NNN>_*/` と `docs/specs/<NNN>_*.md` の抜粋を `/tmp/pr-<PR>-knowledge.md` に書き出す。
   ヒット 0 件なら観点6 を起動しない)
5. **生成物への手編集疑い起票**(`frontend/src/generated/**` / `backend/api/openapi.gen.yaml` が diff に
   含まれていたら Middle 既定で起票 — path_filters で diffmap から除外しても、手編集の事実は別経路で指摘する)
6. subagent 出力の受領(```json フェンス抽出・パース失敗時は再起動1回→縮退)
7. dedup(path × 行レンジ重なり AND 意味的同根)
8. 横断再走査(観点境界の複合欠陥。is_novel_pattern=true は必ず吟味)
9. **code_anchor → line 逆引き**: diffmap の **`text` フィールド**に照合(patch を生 grep しない)。
   text は**行頭 diff marker 除去 + CRLF 正規化済み**で code_anchor と同前処理。**必ず `finding.path` のエントリ内に
   限定**(定型行が多ファイルに頻出するため)。path 内複数ヒットは前後1行で解決、なお一意化不能なら line 未確定でカバレッジに回す。
10. severity 最終確定(PR 全体俯瞰)
11. **確定 findings の永続化**: `/tmp/pr-<PR>-findings.json` に Write(Phase 4 提示前。コンテキスト劣化対策・再レビュー突合元)
12. ビルド・テスト検証(1-0 の worktree で。node_modules は symlink 借用 + 依存系ファイルのブランチ一致確認)
13. worktree 撤去(1-4 の単一トリガ規約。1-3 直後には remove しない — Phase 4/5 後 or E2E 切替承認後)
14. 投稿前の最終ゲート(Phase 5-1。head SHA 陳腐化 / 許可集合突合(start_line 含む)/ 既存コメント重複)

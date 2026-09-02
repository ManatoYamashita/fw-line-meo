# Requirements Document

## Project Description (Input)
Issue #45 のうち「QR 発行の UI 導線」に限定したスペック（親: #41 / 関連 spec: agency-dashboard・review-acquisition）。

### 誰が困っているか

運営（operator）と代理店（agency）— dashboard-web にログインして担当店舗を管理する利用者。飲食店の店頭に置くアンケート QR は、この利用者が発行して印刷・設置する運用になっている。

### 現状

- サーバ側は実装済みで変更不要。`GET /stores/:storeId/qr.png`（`ts/apps/dashboard-api/src/qr.ts`・`app.ts:235`・review-acquisition task 5.3 で完了）が Bearer 認証 + RBAC（operator=全店 / agency=担当店のみ・担当外 403 / 不在 404）付きで PNG を返す。`?size=` は 128〜1024 px・既定 512。応答は `Content-Disposition: attachment; filename="qr-{storeId}.png"`・`Cache-Control: private, no-store`。QR の中身は `{SURVEY_BASE_URL}/s/{storeId}` の URL のみ。`place_status = 'confirmed'` 以外は 409 `PLACE_NOT_CONFIRMED`（「店舗の場所が未確定です。先に確定してください」）。
- 一方 dashboard-web には QR へ到達する導線が 1 つも存在しない。店舗一覧（`ts/apps/dashboard-web/src/app/stores/page.tsx`）は 店名 / 店舗特定 / 競合設定 /（operator のみ）担当代理店 の 4 列のみで、QR を取得する手段がない。
- そのため review-acquisition Requirement 1「代理店・運営が店舗ごとの QR を取得して印刷・設置できる」は UI 側が未充足のまま残っている。本スペックは意匠整備ではなく、要件の欠落を塞ぐ作業である。
- 実装上の既知の障害: (1) エンドポイントは Bearer を要求するため `<a href>` / `<img src>` では取得できない（ブラウザがこの種の遷移に `Authorization` を付けない）。fetch でトークンを添えて取得 → Blob → object URL 経由でダウンロードさせ、object URL は解放する必要がある。(2) `ts/apps/dashboard-web/src/lib/api.ts` は `readJson` を通す JSON 専用（`ApiResult<T>` を返す）で binary 応答の経路がない。(3) `@fwlm/ui` に Dialog / Popover / Tooltip / Select / Table は未ベンダリング（現在の部品は alert / badge / button / card / checkbox / field / heading / input / label / radio-group / separator / spinner / textarea の 13 種）。

### 何が変わるべきか

店舗一覧から、店舗ごとのアンケート QR を発行して PNG としてダウンロードできる導線を dashboard-web に追加し、review-acquisition Requirement 1 を UI 側まで含めて充足させる。あわせて:

- `lib/api.ts` に binary 応答を扱う窓口を追加する。エラー封筒（`{ error: { code, message } }`）の解釈は既存の `apiFetch` と揃え、409 `PLACE_NOT_CONFIRMED` を潰さないこと。
- 未確定店舗（`place_status != 'confirmed'`）の扱いは要件フェーズで決定する。候補は (a) 確定済みの行にだけ QR 操作を出し未確定は理由が読み取れる表現を残す、(b) 常に出して 409 のメッセージを提示する。いずれを採っても review-acquisition Requirement 1.3「Place の確定が先に必要である旨を表示する」を満たすこと。
- 画面内プレビューを出すかは要件・設計での判断。出す場合は取得済みの Blob を使い回す（`no-store` のため再取得は毎回サーバへ届く）。
- overlay 部品（Dialog / Popover）を要する UI を選ぶ場合、`@fwlm/ui` への追加ベンダリングの要否を本スペックの範囲として洗い出す。`theme.css:180-187` に Portal 用の `isolation: isolate` / `position: relative` は先行して入っている。

### スコープ外

Issue #45 の残り — Tailwind / Base UI の全面適用、top-nav・ナビゲーション整備、stores/new フォーム、ログイン画面、admin 配下や invite-codes の意匠、レスポンシブ対応 — は本スペックに含めない（別途 #45 の残タスクとして扱う）。dashboard-api 側の変更も含めない。

### 前提・制約

- dashboard-web は `NEXT_PUBLIC_*` を build-arg で焼き込むアプリ。新しい `NEXT_PUBLIC_*` を増やす場合は Dockerfile の build 段への追加が必須（`scripts/check-next-public-buildargs.sh` が CI で機械強制）。
- 先行 Issue #49（フォーカス可視性）・#50（アルファ合成色）・#51（typecheck 未実行）は解消済み。
- dashboard-web には Playwright 設定がない（#53 が未解決）ため、検証手段は要件・設計フェーズで明示すること。

## Introduction

本仕様は、運営・代理店向け Web ダッシュボードの店舗一覧から、店舗ごとのアンケート QR を発行し、画面で確認したうえで画像ファイルとして保存できる導線を定義する。QR 画像そのものの生成・権限判定・Place 確定判定は `review-acquisition` が提供済みであり、本仕様はそれを利用者が実際に取得できる状態にするまでを担う。これにより `review-acquisition` Requirement 1「代理店・運営が店舗ごとの QR を取得して印刷・設置できる」の未充足部分を閉じる。

以下の受け入れ基準における主語「代理店ダッシュボード」は、`agency-dashboard` と同一の対象、すなわち運営・代理店向け Web 管理画面の機能全体（画面とその背後の要求処理を含む）を指す。

## Boundary Context

- **In scope**: 店舗一覧の各行からの QR 発行操作への到達／発行した QR の画面上での確認／画像ファイルとしての保存と、店舗を判別できるファイル名／店舗の場所が未確定である場合の理由提示／発行失敗時の提示と再試行／発行導線のキーボード操作・支援技術対応・視認性
- **Out of scope**: QR 画像の生成規則・符号化される URL・権限判定・場所の確定判定そのものの変更（`review-acquisition` が確定済み）／Issue #45 の残る意匠整備（ナビゲーション・店舗登録フォーム・ログイン画面・全画面への配色や余白の一斉適用・レスポンシブ対応）／複数店舗の QR の一括発行と印刷面付け（PDF 等）／発行済み QR の失効・再発行・発行履歴の管理／オーナーが LINE 側から QR を取得する導線／客向けアンケート Web 側の挙動
- **Adjacent expectations**: QR の内容（店舗ごとに一意で列挙が容易でないアンケート URL）、認証済みの代理店・運営への限定、担当外店舗の拒否、場所が未確定の店舗に対する発行拒否は `review-acquisition` Requirement 1 が既に定めており、本仕様はこれを前提として変更しない。利用者の認証とロール判定は `agency-dashboard` Requirement 1・2 が提供する。店舗一覧に表示される店舗の範囲・店名・店舗特定と競合設定の状態表示は `agency-dashboard` Requirement 4 が定義済みであり、本仕様はその一覧へ発行導線を加えるのみで表示範囲を変えない。QR の飛び先となる客向けアンケートは `review-acquisition` Requirement 2 が担う。

## Requirements

### Requirement 1: 店舗一覧からの QR 発行導線への到達

**Objective:** As a 代理店・運営, I want 店舗一覧から対象店舗の QR を発行する操作へ直接到達できること, so that 別の画面や問い合わせを挟まずに店頭設置用の QR を用意できる

#### Acceptance Criteria

1. When 利用者が店舗一覧を表示したとき, the 代理店ダッシュボード shall 一覧に表示された店舗のうち場所が確定済みのものについて、その店舗の QR を発行する操作を当該店舗の行から到達できる形で提示する
2. The 代理店ダッシュボード shall QR 発行の操作を、その利用者が一覧で閲覧できる店舗に限って提示し、代理店ロールの利用者に担当外店舗の発行操作を提示しない
3. When 利用者が QR の発行を要求したとき, the 代理店ダッシュボード shall どの店舗に対する発行であるかを操作の実行前と実行後の双方で識別できる形で示す
4. The 代理店ダッシュボード shall 発行導線の追加によって、一覧が既に表示している店名・店舗特定の状態・競合設定の状態・担当代理店の表示を欠落させない
5. The 代理店ダッシュボード shall 競合設定の状態にかかわらず QR 発行の操作を提示する

### Requirement 2: QR の確認とダウンロード

**Objective:** As a 代理店・運営, I want 発行した QR を画面で確認してから画像ファイルとして保存できること, so that 店舗を取り違えたまま印刷して店頭に設置する事故を防げる

#### Acceptance Criteria

1. When 店舗の QR 発行が成功したとき, the 代理店ダッシュボード shall その QR を画面上に表示し、あわせて画像ファイルとして保存する操作を提示する
2. While QR の発行要求を処理している間, the 代理店ダッシュボード shall 処理中である旨を示し、同一店舗に対する発行要求が重複して発生しないようにする
3. When 利用者が表示中の QR の保存を要求したとき, the 代理店ダッシュボード shall 新たな発行要求を行わずに、画面に表示しているものと同一の画像を保存する
4. The 代理店ダッシュボード shall 保存されるファイル名に対象店舗の店名を含める
5. If 店名にファイル名として使用できない文字が含まれるとき, then the 代理店ダッシュボード shall それらを除去または置換したうえで、対象店舗を判別できるファイル名で保存する
6. The 代理店ダッシュボード shall 同一の店名を持つ店舗が複数存在する場合でも、保存されたファイル名から対象店舗を一意に識別できるようにする
7. The 代理店ダッシュボード shall QR の解像度を利用者に選択させず、一般的な家庭用・事務用プリンタで一辺 5cm に印刷した場合にスマートフォンで読み取れる解像度で提供する
8. When 利用者が QR の表示を終了したとき、または別の店舗の QR を発行したとき, the 代理店ダッシュボード shall 直前に表示していた QR を画面上に残さない

### Requirement 3: 場所が未確定の店舗の扱い

**Objective:** As a 代理店・運営, I want QR を発行できない店舗ではその理由と次に取るべき行動が分かること, so that 原因を探し回らずに店舗の場所の確定へ進める

#### Acceptance Criteria

1. While 対象店舗の場所が未確定である間, the 代理店ダッシュボード shall その店舗の行に QR 発行の操作を提示しない
2. While 対象店舗の場所が未確定である間, the 代理店ダッシュボード shall 発行操作に代えて、QR の発行には店舗の場所の確定が先に必要である旨を当該店舗の行から読み取れる形で示す
3. If 一覧の表示内容が古く、発行要求が店舗の場所の未確定を理由に拒否されたとき, then the 代理店ダッシュボード shall 拒否された旨とその理由を提示し、QR が発行されたかのような表示を行わない

### Requirement 4: 発行失敗時の挙動

**Objective:** As a 代理店・運営, I want 発行に失敗したときに何が起きたかが分かり再試行できること, so that 読み取れない QR を店頭に設置する事故を防げる

#### Acceptance Criteria

1. If 発行要求が権限の不足または対象店舗の不在を理由に拒否されたとき, then the 代理店ダッシュボード shall 発行できなかった旨を提示し、担当外の店舗が存在するか否かを推測できる情報を示さない
2. If 利用者の認証が有効でない状態で発行が要求されたとき, then the 代理店ダッシュボード shall QR を提示せず、再度のログインが必要である旨を示す
3. If 通信障害または内部障害により発行要求を完了できないとき, then the 代理店ダッシュボード shall 失敗した旨と再試行できる旨を提示する
4. When 発行に失敗したとき, the 代理店ダッシュボード shall 店舗一覧の表示を維持し、同一店舗および他店舗への再度の発行要求を妨げない
5. The 代理店ダッシュボード shall 発行に失敗した場合に、内容の欠けた画像や代替の画像を QR として提示しない

### Requirement 5: プライバシー・セキュリティ・コンプライアンス境界

**Objective:** As a 運営, I want QR 発行導線がプロダクトの不可侵の制約を破らないこと, so that テナント全体を規約違反や情報漏えいの危険に晒さない

#### Acceptance Criteria

1. The 代理店ダッシュボード shall 利用者の認証情報を、画面のアドレス・画面上のリンク・保存される画像ファイルのいずれにも含めない
2. The 代理店ダッシュボード shall 発行導線のいかなる箇所においても来店客に関する情報を表示しない
3. The 代理店ダッシュボード shall 発行した QR 画像を、利用者がログアウトした後に同一のブラウザから再取得できる形で保持しない
4. The 代理店ダッシュボード shall 1 つの店舗に対して単一のアンケート導線の QR のみを提供し、評価の内容や客の属性によって異なる導線を出し分けない
5. The 代理店ダッシュボード shall 発行導線に表示する文言をすべて日本語で提供する

### Requirement 6: 操作性とアクセシビリティ

**Objective:** As a キーボードや支援技術を用いて日常的に管理画面を操作する代理店・運営, I want 発行導線をマウスなしでも把握・操作できること, so that 日々の店舗管理作業が滞らない

#### Acceptance Criteria

1. The 代理店ダッシュボード shall 発行導線のすべての対話的要素をキーボードのみで操作可能とし、現在の焦点がどこにあるかを視覚的に判別できる状態にする
2. When 発行の状態が処理中・成功・失敗のいずれかに変化したとき, the 代理店ダッシュボード shall その変化を支援技術にも伝わる形で通知する
3. The 代理店ダッシュボード shall 発行導線の操作要素を、どの店舗に対する操作であるかが支援技術からも判別できる名前で提示する
4. Where QR を画面上に表示する場合, the 代理店ダッシュボード shall 表示した画像に対象店舗を判別できる代替テキストを与える
5. The 代理店ダッシュボード shall 発行導線に用いる文字のコントラスト比を 4.5:1 以上、操作要素の境界・状態を示す非文字要素のコントラスト比を 3:1 以上とする

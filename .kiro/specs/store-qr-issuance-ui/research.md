# Gap Analysis — store-qr-issuance-ui

_作成: 2026-08-21 / 対象: `.kiro/specs/store-qr-issuance-ui/requirements.md`（Requirement 1〜6・AC 31 件）_

本文書は要件と既存コードの差分を測り、設計フェーズへ判断材料を渡すものである。実装方針の最終決定は行わない。

## 1. 現状調査（実測）

### 1.1 サーバ側は完成しており変更不要

| 項目 | 実測値 | 出典 |
|---|---|---|
| エンドポイント | `GET /stores/:storeId/qr.png` | `ts/apps/dashboard-api/src/app.ts:235` |
| 認証・RBAC | Bearer 検証 → 未認証 401 / 未登録・無効化 403 / 不在 404 / 担当外 403 | `ts/apps/dashboard-api/src/qr.ts:22-42` |
| 未確定店舗 | `placeStatus !== 'confirmed'` で 409 `PLACE_NOT_CONFIRMED` | `qr.ts:44-47` |
| 応答 | `image/png` ／ `attachment; filename="qr-{storeId}.png"` ／ `private, no-store` | `qr.ts:49-61` |
| サイズ | `?size=` を 128〜1024 に丸め、非数値・未指定は 512 | `app.ts:72-76` |
| QR の中身 | `{SURVEY_BASE_URL}/s/{store.id}` のみ | `qr.ts:54` |
| 既存テスト | `test/qr.test.ts` ／ `test/qr.db.test.ts`（RBAC 統合） | `ts/apps/dashboard-api/test/` |

### 1.2 dashboard-web の UI 基盤は既に接続済み（Issue #45 コメントの記載より前進している）

Issue #45 のコメントは「3 面とも部品 import が 0 件」「`transpilePackages` 未設定」と述べているが、実測では次のとおり状況が変わっている。

- `package.json` は `@fwlm/ui: workspace:*` と Tailwind v4 ツールチェーンを保持している
- `src/app/globals.css` は 3 点セット（`@import "tailwindcss"` → `@import "@fwlm/ui/theme.css"` → `@source "../../../../packages/ui/src"`）を規定順で持つ
- `src/app/layout.tsx` は既にトークン系ユーティリティ（`bg-background` `text-foreground` 等）で描画している
- `next.config.ts` に `transpilePackages` は無いが、これは survey-web / store-detail も同じで、その 2 面は実際に `@fwlm/ui/components/button` を使って稼働している（`ts/packages/ui/test/app-integration.test.ts` が 3 面すべてについて解決可能性と生成まで機械検証している）

つまり **QR 導線のために基盤整備を先行させる必要はない**。不足しているのは部品の利用実績だけである。

### 1.3 利用可能な部品と、無い部品

`ts/packages/ui/src/components/` に 13 件: alert / badge / button / card / checkbox / field / heading / input / label / radio-group / separator / spinner / textarea。

**Dialog / Popover / Tooltip / Select / Table は存在しない**（Base UI の overlay 系プリミティブは未ベンダリング）。`theme.css:180-187` に Portal 用の `isolation: isolate` / `position: relative` だけが先行して入っている。

### 1.4 dashboard-web の既存パターン

- 画面: `src/app/**/page.tsx`、共通部品: `src/components/*.tsx`、通信: `src/lib/api.ts`
- 状態表現: 判別共用体（`{ kind: 'loading' | 'error' | 'ready' }`）を各画面がローカルに持つ（`stores/page.tsx:11-16`）
- 検証: vitest + Testing Library。`test/` に 13 本。jsdom が要るファイルは先頭に `// @vitest-environment jsdom` を書く個別指定方式
- モック規約: `next/navigation` `next/link` `../src/lib/api` `../src/lib/auth-context` をモックし、firebase と実 fetch を発火させない（`test/stores-page.test.tsx:6-26`）
- Playwright は survey-web のみ。dashboard-web に E2E は無い（Issue #53・未解決）

## 2. 要件 → 資産マップ

| 要件 | 既存資産 | 差分 | 種別 |
|---|---|---|---|
| 1.1 確定済み店舗の行から発行操作へ到達 | `stores/page.tsx` のテーブル（4 列） | 列または行内領域の追加 | Missing |
| 1.2 閲覧できる店舗に限って提示 | `getStores` が既にロール別スコープ済み | 一覧の行集合をそのまま使えば自動的に成立 | 充足済み |
| 1.3 対象店舗の識別 | 行の店名 | 操作要素と結果表示への店名の結線 | Missing |
| 1.4 既存 4 列を欠落させない | 既存テーブル | 追加のみ。既存テストが回帰を検出する | Constraint |
| 1.5 競合設定の状態に依存しない | — | サーバ側も競合を見ていない（`qr.ts` は place のみ判定） | 充足済み |
| 2.1 画面表示＋保存操作 | Card / Button / Spinner | 表示領域の新設 | Missing |
| 2.2 処理中表示・重複要求の抑止 | Spinner・判別共用体の慣行 | 店舗単位の進行状態管理 | Missing |
| 2.3 保存時に再取得しない | — | 取得済みバイト列の保持が必須（`no-store` のため再取得は必ずサーバへ届く） | Missing |
| 2.4〜2.6 店名入りファイル名・使用不可文字・同名店舗 | — | **サーバの `Content-Disposition` はこの経路で読めない**（§3.1） | Missing |
| 2.7 印刷解像度 | `?size=` 128〜1024 | 要求サイズの決定（設計判断） | Unknown |
| 2.8 切替時に前の QR を残さない | — | 表示解除と資源解放 | Missing |
| 3.1〜3.2 未確定店舗は操作を出さず理由を示す | `StoreListItem.placeStatus` を一覧が保持済み | 行単位の分岐表示 | Missing |
| 3.3 古い表示で拒否された場合 | サーバの 409 | エラー封筒の 409 を潰さない解釈 | Constraint |
| 4.1〜4.5 失敗時の挙動 | `parseErrorEnvelope`（`api.ts:74-103`）が code/message を判別共用体へ写す | binary 経路でも同じ解釈を通す | Missing |
| 5.1 認証情報をアドレス・リンク・ファイルに含めない | Bearer をヘッダで送る既存規約 | クエリ経由のトークン受け渡しを設計で排除する | Constraint |
| 5.2 客の情報を表示しない | QR の中身は URL のみ・一覧に客の情報は無い | — | 充足済み |
| 5.3 ログアウト後に再取得できる形で残さない | — | 保持先を揮発領域に限る（永続保存を採らない） | Constraint |
| 5.4 単一導線のみ | サーバが店舗ごとに 1 URL を返す | — | 充足済み |
| 5.5 日本語 | 既存の全文言が日本語 | 追加文言も同様 | Constraint |
| 6.1 キーボード操作・焦点可視 | `theme.css` の `@layer base` にグローバル `:focus-visible`（Issue #49 で是正済み） | 部品を使う限り自動的に成立 | 充足済み |
| 6.2 状態変化を支援技術へ通知 | 既存画面は `role="alert"` のみ使用 | 進行・成功の通知手段が未確立 | Missing |
| 6.3 操作要素の名前で店舗を判別 | `top-nav.tsx` に `aria-label` の前例 | 行ごとの名前付け | Missing |
| 6.4 画像の代替テキスト | — | 表示時に付与 | Missing |
| 6.5 コントラスト 4.5:1 / 3:1 | `contrast-usage.test.ts` が検証 | **検証範囲はパッケージ内の部品のみ**（§3.2） | Constraint |

## 3. 確定した技術的制約（実測で確認したもの）

### 3.1 サーバの `Content-Disposition` はブラウザに届かない — 二重の理由

1. Bearer を要求するため `<a href>` / `<img src>` では取得できない（ブラウザはこの種の遷移に `Authorization` を付けない）
2. dashboard-api の CORS は `allowHeaders: ['Authorization', 'Content-Type']` のみで **`exposeHeaders` を持たない**（`app.ts:110-117`）。dashboard-web と dashboard-api は別オリジンの Cloud Run サービスであり、既定で読めるのは安全リストのヘッダだけなので、仮にファイル取得経路を変えても `Content-Disposition` は読めない

よって Requirement 2.4〜2.6 の「店名入りファイル名」は UI 側で決める以外に手段が無い。これは選好ではなく制約である。

### 3.2 コントラスト検証はアプリ層の className を見ていない

`ts/packages/ui/test/contrast-usage.test.ts` が走査するのは `ts/packages/ui/src/components/` だけである。一方 `scripts/check-design-tokens.sh` は `ts/apps/**` も対象にするが、見るのは「直書き hex」と「生パレット色クラス」であってコントラスト比ではない。

したがって、新しい配色を **アプリ層の className として書くと Requirement 6.5 は機械検証の外に出る**。設計では次のいずれかを選ぶ必要がある。

- (i) 新しい色指定を持ち込まず、既存の意味論トークンの組み合わせ（部品の variant）だけで構成する
- (ii) 色を持つ部分を `@fwlm/ui` の部品として実装し、既存ガードの網に入れる
- (iii) ガードの走査範囲をアプリ層へ広げる（本 spec の範囲を超える）

### 3.3 jsdom には Blob URL が無い

`ts/node_modules/.pnpm/jsdom@25.0.1` の `lib/` 全体を走査して `createObjectURL` の実装は **0 件**（`Blob` 自体は `living/file-api/Blob-impl.js` に存在する）。ダウンロード経路をコンポーネントテストで通すには、資源の確保・解放を注入可能な境界として切り出すか、テスト側で `URL.createObjectURL` / `revokeObjectURL` を差し込む必要がある。既存 13 本のテストにこの前例は無い。

### 3.4 この種の取得はリポジトリ初導入

`createObjectURL` / `revokeObjectURL` / `new Blob` / `res.blob()` / `download=` 属性の使用箇所は、アプリコード全体で **0 件**（`dashboard-api/test/qr.test.ts:112` の `arrayBuffer()` はサーバ側テストの検証用）。踏襲すべき前例が無いため、規約は本 spec で確立することになる。

### 3.5 `lib/api.ts` は JSON 専用

`apiFetch` は成功時に必ず `readJson` を通し `ApiResult<T>` を返す（`api.ts:85-115`）。binary の窓口を足す際、エラー時の `parseErrorEnvelope` は共有できるが、成功時の分岐は別経路になる。409 の `code` を握り潰すと Requirement 3.3 と 4.1 が同時に壊れる。

### 3.6 新しい `NEXT_PUBLIC_*` は不要

QR の取得先は既存の `NEXT_PUBLIC_API_BASE_URL` で足りる（`Dockerfile:35-42` に 4 件の `ARG` が既に存在）。したがって `scripts/check-next-public-buildargs.sh` に関わる作業は発生しない。

## 4. 実装アプローチの選択肢

### Option A: 既存ファイルの拡張のみ

`lib/api.ts` に binary 窓口を足し、`app/stores/page.tsx` の行内に発行操作と表示領域を直接書く。新規ファイルは作らない。

- ✅ 追加ファイル 0・最短で到達できる
- ✅ 既存の判別共用体パターンをそのまま延長できる
- ❌ `stores/page.tsx` が「一覧の描画」に加えて「取得・資源管理・保存」まで抱え、単一責任が崩れる
- ❌ §3.3 の資源管理を画面コンポーネント内に埋めると、テストのために画面全体を jsdom で動かす必要が出る
- ❌ `api.ts` は既に約 300 行の型付き窓口の集合で、binary という異質な戻り値型を混ぜると読み手の負荷が上がる

### Option B: overlay 部品を新設して独立させる

`@fwlm/ui` へ Base UI の Dialog をベンダリングし、`components/store-qr-dialog.tsx` として実装する。

- ✅ 行内に情報を押し込まずに済み、印刷前の確認に十分な表示面積が取れる
- ✅ Dialog は Issue #45 の他タスク（一覧の操作メニュー等）でもいずれ要る
- ❌ ベンダリング 1 件につき `contrast-usage.test.ts` の検証表・`components.test.tsx`・`color-mix-allowlist.json` への追記が付随し、作業量が本題から膨らむ
- ❌ 焦点の閉じ込め・復帰・`Escape` の扱いが新規の検証対象として増える（Requirement 6.1・6.2 の負担が増す）
- ❌ overlay の是非は本来 Issue #45 本体の意匠判断であり、QR 導線がその判断を先取りして固定してしまう

### Option C: 薄い新規モジュール ＋ 既存部品での行内表示（推奨）

1. `lib/qr.ts`（新規・小）— 取得とファイル名決定。エラー封筒の解釈は `api.ts` の既存関数を再利用し、資源の確保・解放を注入可能な境界として持つ
2. `components/store-qr-panel.tsx`（新規）— 既存の Card / Button / Alert / Spinner だけで表示・保存・失敗表示を構成
3. `app/stores/page.tsx`（拡張・小）— 行に操作を足し、未確定行には理由を出す

- ✅ 新規ベンダリングが不要で、`@fwlm/ui` の検証表に触れずに済む
- ✅ §3.3 の資源管理が `lib/qr.ts` に閉じ、node 環境のユニットテストで直接検証できる（jsdom を必要とするのは表示部分だけ）
- ✅ overlay の採否を Issue #45 本体へ残せる。後から Dialog へ移す場合も `store-qr-panel` の中身は再利用できる
- ✅ §3.2 の (i) を選びやすい（部品の variant のみで構成しやすい）
- ❌ 行内表示は表示面積が限られ、一覧の縦方向のレイアウトが動く
- ❌ ファイルが 2 件増える

## 5. 工数とリスク

| 項目 | 評価 | 根拠 |
|---|---|---|
| 工数 | **S（1〜3 日）** | サーバ変更ゼロ・新規依存ゼロ・新規 `NEXT_PUBLIC_*` ゼロ。既存の画面・テスト規約をそのまま延長でき、追加は薄いモジュール 1 件と表示部品 1 件 |
| リスク | **Low〜Medium** | Low の根拠: API 契約が確定済みで RBAC・409 はサーバ側テストで既に緑。Medium へ押し上げる要因は 3 つ — (a) Blob 取得がリポジトリ初導入で前例が無い、(b) jsdom に Blob URL が無くテスト戦略の確立が要る、(c) 実ブラウザでの実ダウンロードは dashboard-web に E2E が無いため機械検証できない（Issue #53） |

## 6. 設計フェーズへの申し送り

### 決めるべきこと

1. **表示形態** — 行内展開か overlay か（Option B / C の分岐）。overlay を採るならベンダリング作業を本 spec のタスクに明示的に含めること
2. **要求サイズ** — Requirement 2.7 を満たす `?size=` の値。1024 は最大かつ印刷余裕が最も大きいが、`no-store` のため毎回転送が発生する
3. **ファイル名の規則** — Requirement 2.4〜2.6 を同時に満たす形（店名の正規化規則と、同名店舗を分ける識別子の付け方）
4. **資源解放の境界** — Requirement 2.8・5.3 を成立させる解放点を、どのモジュールが所有するか
5. **状態通知の手段** — Requirement 6.2 を満たす通知（既存画面は `role="alert"` のみで、進行中・成功の通知に前例が無い）
6. **配色の置き場所** — §3.2 の (i) / (ii) / (iii) のいずれを採るか

### Research Needed（設計フェーズで確認する）

- `URL.createObjectURL` を使わない代替（`data:` URL 化など）が Requirement 5.3 と両立するか。採否で資源解放の設計が変わる
- 保存操作のファイル名指定が、対象ブラウザ（PC 主用途・タブレット考慮）で意図どおり反映されるか
- Requirement 2.7 の「一辺 5cm で読み取れる」を、どの手順で一度だけ実測して記録するか（自動検証は E2E 不在のため不可）
- 一覧の行数が多い運営ロールで、行内表示がレイアウトに与える影響

### 引き継ぐ制約

- サーバの応答ヘッダは読めない（§3.1）。ファイル名は UI が決める以外に手段が無い
- 409 の `code` を潰さない（§3.5）。潰すと Requirement 3.3 と 4.1 が同時に壊れる
- コントラストの機械検証はアプリ層へ届かない（§3.2）

---

# Design Discovery & Decisions — store-qr-issuance-ui

_追記: 2026-08-21（`/kiro-spec-design` 実行時）_

## Summary

- **Feature**: `store-qr-issuance-ui`
- **Discovery Scope**: Extension（既存 dashboard-web への機能追加。light discovery を適用）
- **Key Findings**:
  - ダウンロード方式は Blob URL が唯一の堅牢な選択肢である。`data:` URL は Safari と Chrome の双方に既知の制限があり、Blob URL は主要ブラウザで長期に渡り安定している
  - プレビューと保存を **同一の object URL で兼ねられる** ため、プログラムによる click 合成も再取得も不要になる。これが設計を一段階簡素化した
  - 新規ベンダリングも新規依存も不要。`Card` / `Button` / `Alert` / `Badge` / `Spinner` の既存 variant だけで要件を満たせる
  - `text-muted-foreground` は実 hex `#666666` で `contrast-usage.test.ts` の検証表に登録済みであり、アプリ層で使ってもコントラストの根拠が既に存在する

## Research Log

### ダウンロード方式: Blob URL と data URL の比較

- **Context**: Requirement 2.3（再取得しない）・2.4〜2.6（ファイル名）・2.8 と 5.3（残さない）を同時に満たす方式の選定。§3.1 のとおりサーバのヘッダは読めないため、取得したバイト列をクライアント側で保存させる必要がある
- **Sources Consulted**: MDN `URL.createObjectURL()`、ブラウザ実装状況の調査（下記 References）
- **Findings**:
  - Blob URL は Chrome 8+ / Firefox 4+ / Safari 6+（macOS・iOS）で利用でき、`download` 属性と組み合わせた保存の標準的な手段である
  - Safari は `download` 属性を same-origin・blob・data の各 URL に対して尊重する。一方 `data:` URL による保存は Safari の既知の不具合報告があり、Chrome も `data:` URL への遷移を制限している
  - MDN は object URL の解放に `revokeObjectURL()` を呼ぶことを明示している。Service Worker で利用できないのはメモリリークの懸念が理由であり、解放を怠れば文書の生存期間だけ確保が残る
  - Firefox は cross-origin URL に対して `download` 属性そのものを無視して遷移へ倒す。blob URL は生成元の browsing context に閉じた same-origin 扱いのためこの制約に触れない
- **Implications**: Blob URL を採用し、解放の所有者を 1 箇所へ固定する。`data:` URL は採らない

### プレビューと保存の統合

- **Context**: 当初は「プレビュー用の表示」と「保存のための取得」を別経路として想定していた（研究フェーズの Requirement 2.3 は再取得の禁止として表現されている）
- **Findings**: `<img src>` と `<a download href>` はどちらも同一の object URL を参照できる。したがって取得は 1 回、URL の生成も 1 回で足りる
- **Implications**: プログラムによる click 合成（`document.createElement('a')` → `click()`）が不要になり、保存操作を **実際のリンク要素** として描画できる。結果として Requirement 6.1（キーボード操作）と 2.3（再取得しない）が実装上の追加作業なしで成立する

### 未確定店舗の二重判定について

- **Context**: Requirement 3.1〜3.2 は一覧側の `placeStatus` で分岐し、3.3 はサーバの拒否にも備えることを求める。判定がクライアントとサーバの 2 箇所に存在する形になる
- **Findings**: `StoreListItem.placeStatus` は一覧取得時点のスナップショットであり、別の利用者が確定させた直後などに古くなり得る。サーバ側 `qr.ts:44-47` は常に最新の状態で判定する
- **Implications**: クライアント側の判定は **表示の最適化** であり権限判定ではない。真正の判定はサーバのみが持つ、という役割分担を design で明記する。UI 側の分岐が誤っても安全側（サーバが拒否する）へ倒れる

## Architecture Pattern Evaluation

| Option | 概要 | 強み | リスク・限界 | 判断 |
|---|---|---|---|---|
| A: 既存ファイルの拡張のみ | `stores/page.tsx` に取得・資源管理・保存まで直接書く | 追加ファイル 0 | 画面が 3 つの責務を抱える。資源管理のテストに jsdom が必須になる | 不採用 |
| B: overlay 部品の新設 | `@fwlm/ui` へ Dialog をベンダリングし専用ダイアログを作る | 表示面積が取れる | 検証表 3 件への追記が付随。焦点の閉じ込めが新たな検証対象。overlay の採否は Issue #45 本体の判断 | 不採用 |
| C: 薄い新規モジュール ＋ 既存部品での行内表示 | 取得とファイル名を薄いモジュールへ、表示を既存部品で構成 | 新規ベンダリング不要。純粋ロジックを node 環境で検証できる | 表示面積が限られる | **採用** |

## Design Decisions

### Decision: 取得の窓口を `lib/api.ts` に置く

- **Context**: `apiFetch` は JSON 専用（§3.5）。binary の窓口をどこへ置くか
- **Alternatives Considered**:
  1. `lib/qr.ts` に独立した取得関数を置く — トークン付与とエラー封筒の解釈を再実装することになる
  2. `lib/api.ts` へ `apiFetchBinary` を追加する — 既存の内部関数を再利用できる
- **Selected Approach**: 2。`api.ts` 冒頭のコメントが宣言する「Bearer 付与・エラー封筒の解釈を一箇所に集約する」という不変条件を守る
- **Rationale**: 解釈が 2 箇所に分かれると、409 の扱いが片方だけ壊れる形の退行が起き得る。Requirement 3.3 と 4.1 は同じ解釈経路に依存している
- **Trade-offs**: `api.ts` の行数は増えるが、戻り値の型は `ApiResult<T>` のまま揃う
- **Follow-up**: 成功応答が空の場合を失敗として扱うこと（Requirement 4.5）

### Decision: 保存はリンク要素で行い、プログラムによる click 合成を採らない

- **Context**: Requirement 2.3・6.1
- **Alternatives Considered**:
  1. 保存ボタン押下時に `<a>` を生成して `click()` を合成する — 一般的な手法だが DOM 操作が増え、jsdom での検証が重い
  2. object URL を `href` に持つ実リンクを描画する
- **Selected Approach**: 2
- **Rationale**: 取得済みの URL をそのまま束ねられるため再取得が原理的に起きない。実リンクはキーボードと支援技術の双方で標準的に扱える
- **Trade-offs**: 「保存」がボタンではなくリンクになるため、見た目の統一は Button の variant を link 相当で当てるか、リンクにボタン様のクラスを当てるかで揃える必要がある
- **Follow-up**: リンクに `download` 属性が効くことは実ブラウザで一度だけ確認する（E2E 不在のため）

### Decision: ファイル名は `qr-<正規化した店名>-<storeId の先頭 8 文字>.png`

- **Context**: Requirement 2.4・2.5・2.6
- **Alternatives Considered**:
  1. 同名店舗を検出したときだけ識別子を付ける — 一覧が絞り込まれている場合に検出が成立しない
  2. 常に識別子を付ける
- **Selected Approach**: 2。加えて正規化後に空になった店名でもファイル名が成立する
- **Rationale**: 一覧の内容に依存しない規則にすれば、表示範囲やロールが変わっても 2.6 が壊れない
- **Trade-offs**: ファイル名が数文字長くなる
- **Follow-up**: 正規化規則の対象文字集合を単体テストで固定する

### Decision: 要求サイズは 1024 に固定する

- **Context**: Requirement 2.7。API は 128〜1024 を受け付け、未指定は 512
- **Selected Approach**: 上限の 1024 を明示的に要求する
- **Rationale**: 受け入れ基準は卓上 POP と店頭掲示の双方を含む。掲示物は拡大印刷され得るため、余裕の大きい側を既定にする。QR は情報量が小さく PNG も小さいため、転送量の増分は運用上無視できる
- **Trade-offs**: `no-store` のため発行のたびに転送が発生するが、発行は人手の稀な操作である

### Decision: 新しい色指定を持ち込まない

- **Context**: §3.2 のとおりアプリ層の className はコントラスト検証の外にある
- **Selected Approach**: §3.2 の選択肢 (i)。`@fwlm/ui` の部品が既に使用している意味論トークンのみを用いる
- **Rationale**: `text-muted-foreground` は `#666666` として `contrast-usage.test.ts` の検証表に登録済みで、根拠を新たに作る必要がない。(iii) のガード拡張は本 spec の境界外
- **Trade-offs**: 配色の自由度は下がるが、本 spec の目的は意匠ではなく要件の欠落を塞ぐことである

## Synthesis Outcomes

- **Generalization**: 「認証付きで binary を取得し、エラー封筒は既存と同じ解釈を通す」は QR に固有ではない。したがって `apiFetchBinary` は **インターフェースだけを一般化** し、実装は QR の 1 用途に留める
- **Build vs Adopt**: 保存処理に外部ライブラリを採らない。Blob・object URL・`download` 属性というプラットフォーム標準で足り、steering の「外部ライブラリは必要性を吟味して最小限に」に沿う。エラー封筒の解釈も既存 `parseErrorEnvelope` を採用し再実装しない
- **Simplification**: 当初案にあった「保存用の関数」「object URL を抽象化する port」「Dialog 部品」をいずれも削除した。実装が 1 つしかない抽象を作らない

## Risks & Mitigations

- 実ブラウザでの保存動作を機械検証できない（dashboard-web に E2E が無い・Issue #53）— 実装時に手動確認を 1 回行い、その結果を tasks の完了条件へ書く
- jsdom に `createObjectURL` が無い（§3.3）— 表示部品のテストでのみ差し込む。純粋ロジックは node 環境で検証し、差し込みに依存させない
- サーバは 403 と 404 で異なる文言を返す（`qr.ts:31-38`）— 本 UI は両者を同一文言で提示する。サーバ側の区別の是非は `review-acquisition` の所有であり本 spec では変更しない

## References

- [URL.createObjectURL - MDN](https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static) — object URL の解放義務とメモリリークの注意
- [Blob URLs: Browser Support, Features, Limitations](https://www.testmuai.com/learning-hub/blob-url-browser-support/) — Blob URL の対応状況と iframe sandbox 等の限界
- [HTML Download Attribute: Browser Support, Filename, CORS](https://www.testmuai.com/learning-hub/html-download-attribute-browser-support/) — `download` 属性の対応と cross-origin の扱い
- [HTML Download Attribute using data URI - Apple Developer Forums](https://developer.apple.com/forums/thread/686282) — `data:` URL による保存の既知の問題

# Research & Design Decisions

## Summary
- **Feature**: `store-detail-trend-dashboard`
- **Discovery Scope**: Extension（既存の `ts/apps/store-detail` の 1 画面に、表示だけを変える操作と描画を足す。API・DB・Go は変えない）
- **Key Findings**:
  - 店舗詳細は、ページ全体が 1 つのクライアント部品（`app/store/page.tsx` の 1 行目が `'use client'`）である。取得済みの応答を手元で絞り込めば、再取得も書込も起きない。
  - read-only 構造契約（ui-airbnb-surfaces 要件 3.1）は、`form, button, input, textarea, select` を 0 件にすることを代理指標にしている。`@fwlm/ui` の `RadioGroup`（Base UI 1.6）は `<span role="radio">` と隠し `<input type="radio">` を描くので、この代理指標に当たる。**許可リスト方式へ書き換える**必要がある。
  - dataviz の記号仕様（線 2px・端点 8px と地色の輪 2px・罫線は実線の極細・単一系列なら凡例箱は不要・表を併置）は、既存トークンだけで満たせる。本文色・区切り線色・補助文字色・カードの地色の 4 つがあれば足りる。「ホバー層を既定で付ける」と「全点に 8px の印」の 2 点は、この面の制約と衝突するため採らない（下の決定を参照）。

## Research Log

### 既存の画面構造と、既存テストが固定しているもの
- **Context**: 既定状態の DOM を変えずに機能を足せるか確かめるため。
- **Sources Consulted**:
  - `ts/apps/store-detail/app/store/page.tsx`（#266 の取り込み後で 666 行）
  - `test/store-page.test.tsx`（1335 行）
  - `e2e/store-surface.spec.ts`、`e2e/fixtures/detail.ts`、`e2e/a11y-audit.spec.ts`
- **Findings**:
  - 構造テストが完全一致で固定しているもの:
    - section は 3 個で、クラスも一致
    - ul は 2 個（`divide-y`）
    - Card は 5 枚
    - 表は 1 個。列見出しは 4 つ、行数は推移の件数＋1
    - h2 / h3 の読み上げ名
    - 推移の要約の `dl dt` / `dd`（e2e）
    - 捲れる領域は 1 個（`TABLE_SCROLL_REGIONS = 1`）
  - `data-slot` を持たない要素の class に任意値（`[`）を書くと、赤になる。
  - 面の側の className を固定するテストは section と ul しか見ていない。一方で、`page.tsx` 冒頭のコメントは「面の側に色を書かない」を規律として定めている。
  - 単体テストの応答 `mockResult` は、競合 1 店・推移 2 日である。e2e の fixture は、長い店名・推移 30 点・競合 5 店・母数 24 を持つ。
- **Implications**:
  - グラフは既存の要約カード「表示期間の変化」の中に置き、h2 と表の名前は期間から導く。こうすれば、既定状態（30 日・順位）の DOM は現行と一致する。
  - 赤くなる既存テストは、書込要素 0 件の検査 2 件（正常系と 4 分岐）に限られる。
  - 面の側が色を書くのは、この画面ではグラフが初めてになる。そのため判断を正典（§7.19）へ書き、使ってよい色の語彙を完全一致で固定する新しい検査を足す。

### 契約を担保している層
- **Sources Consulted**:
  - `.kiro/specs/competitive-daily-summary/requirements.md` 4.2
  - `.kiro/specs/ui-airbnb-surfaces/requirements.md` 3.1・3.3
  - `.kiro/specs/ui-airbnb-foundation/design.md` D6
  - `docs/design/design-language.md` §7.5・§8
  - `test/route.db.test.ts`（GET のみ）
  - `db/test/check_no_optional_capabilities.sh` B3（route は `api/detail` だけ）
  - `infra/sql/grants.sql`（store-detail の SA は SELECT のみ）
- **Findings**:
  - 要件 4.2 が禁じているのは書込操作である。書込を不可能にしている担保は DB 権限と GET だけの route の 2 層で、どちらも今回は変えない。
  - 3.1 は、4.2 の上に置かれた構造上の代理指標にあたる。
- **Implications**:
  - 改定は 3.1 と 3.3 の日付つき訂正にとどめる。4.2 は真のまま残す。
  - 代理指標は次の 3 つを検査する形に強める。
    - 許可した入力だけを置いていること
    - 操作しても要求・保存・URL が変わらないこと
    - 名前付きの入力や、フォームへ紐づく入力が無いこと

### 部品と環境の制約
- **Sources Consulted**:
  - `@base-ui/react/radio/root/RadioRoot.js`
  - `ts/packages/ui/src/components/{radio-group,field,input,card}.tsx`
  - `ts/packages/ui/test/components.test.tsx`（PointerEvent の互換実装）
  - `.kiro/specs/ui-a11y-gaps/design.md`（44px はラベル行で満たす）
  - `ts/eslint.config.js`
  - survey-web の `ui-check`（RadioGroup の組み方）
- **Findings**:
  - `Radio.Root` は `nativeButton=false` が既定で、`<span role="radio">` と `<input type="radio" aria-hidden tabindex=-1>` を描く。クリックは `new PointerEvent('click')` で隠し input へ転送される。jsdom 25 は `PointerEvent` を実装していない。
  - `FieldLabel` が `Field` を包む構成では、`min-h-11`（44px）が効き、選択されると枠とうすい面が変わる（部品側の意匠）。
  - RadioGroup は、どの本番面でもまだ使われていない。組み方の前例は ui-check だけである。
  - `Input` の高さは `h-8` である。44px は、縦に積む Field とラベル行の構成で満たす（ui-a11y-gaps 要件 4.7）。
  - クライアントへ同梱されるファイルから root の `@fwlm/db` を値として import することは lint が禁じている。ただしこの規則が効くのは `apps/store-detail/app/**` と `lib/contract.ts` だけで、`lib/` に新しく足した純関数は網の外に出る。
  - `<search>` 要素について:
    - jsdom 25 は未知要素として扱い、React の開発版が警告を出す。
    - aria-query 5.3 はこの要素を search の役割に対応づけていない。
    - axe はランドマークとして扱う。
- **Implications**:
  - 切替は `RadioGroup` と Field の構成で作る。検索は、縦に積む `Field` と `FieldLabel htmlFor` と `Input type="search"` で作る。`<search>` は使わない。
  - 新しい `lib/*.ts` は lint の対象一覧へ加える。

### dataviz の記号仕様（2026-09-13 に dataviz スキルを参照）
- **Findings**:
  - 形: 時間の推移で系列が 1 つなら線グラフにする。二重軸は禁止し、2 つ目の尺度は別のグラフにする。
  - 線は 2px で、角と端を丸める。端点の印は 8px 以上とし、地色の輪 2px を付ける。罫線と軸は極細の実線で、目立たせない。
  - 系列が 1 つなら凡例箱は要らない。題が系列を名指しする。
  - 直接ラベルは絞って付ける（線なら端点）。文字は系列の色ではなく、文字用のトークンで描く。
  - 表の併置は必須である。ツールチップは補助にとどめ、値の取得をツールチップに頼らない。
  - フィルタはカードの外に 1 列で置き、下にあるものすべてに効かせる。日付の範囲を最初に置く。
  - 固定高の容器は、x 軸の帯を含めた高さにする。含めないと、容器の中で縦に捲れる。
  - 目盛りは切りのよい数値にし、`tabular-nums` を使う。大きい単独の数値には `tabular-nums` を使わない。
- **Implications**: 下の決定 D2〜D5 に反映した。

### design 検証での実測（2026-09-13・独立審査）
- **Context**: `kiro-validate-design` で、独立審査役が設計の前提を 2 つの描画エンジンで実測した。
- **Findings**:
  - **長さ 0 の線分を丸い端で描いた点**（`viewBox="0 0 100 100"` と `preserveAspectRatio="none"`、190×160px の箱、太さ 8）:
    - Chromium（Playwright 1.61。DPR 2.75 と 1）では 8×8 CSS px の真円になった。塗られた画素数は 378 で、理論値 380 と一致する。
    - macOS 15.6 のシステム WebKit（WKWebView）では、`vector-effect: non-scaling-stroke` の有無や `path d="M50 50 L50 50"` にしても、15×13px の楕円になった。WebKit は、長さ 0 の部分経路の丸い端を、viewBox の縦横それぞれの伸縮どおりに歪める。長さのある polyline は太さ 8px を保つので、non-scaling-stroke 自体は効いている。
    - iOS 実機は未確認。iOS の WKWebView も同じ描画系だと推測している。
    - 2026-09-16 追記（タスク 5.4 の実描画）: **Playwright の WebKit 26.5 では、この当初案が 8×8 CSS px の真円になり、欠陥が再現しない**。Playwright の WebKit は Safari 26 系の別ビルドである。したがって、**決定 D2 の根拠を Playwright の webkit だけで確かめ直すことはできない**。「webkit で再現しないから D2 は不要」と読み替えてはならない。
      - 同じ描き方は、macOS 15.6 のシステム WebKit では 15×12 CSS px（320px 幅）・21×12 CSS px（393px 幅）の楕円になった。上の 2026-09-13 の実測（190×160 の箱で 15×13）とは、箱の寸法が違うので数値は一致しないが、縦横が食い違う楕円になるという結論は同じである。
      - このとき、システム WebKit では「長さ 0 の丸い端」と「伸縮する層の中の circle」が同じ寸法（30×24 device px）になる。`non-scaling-stroke` が無視され、どちらも viewBox の伸縮どおりに歪むためである。注入が効いていることは、注入前の絵との差（6974 画素・外接箱は描画領域と一致）で確かめた。
      - 採用案（viewBox を持たない層の circle）は、3 つのエンジンで真円だった。判定は、被覆率 0.5 のしきい値での外接箱（8.00×8.00 CSS px。ただし Chromium の 393px 幅の端点だけは 22×21 device px ＝ 反射防止の端 1 画素ぶん縦が短い）と、塗られた面積（理論値の +0.46〜+1.1% 以内）、等価直径（7.98〜8.04 CSS px）による。
  - **viewBox を持たない SVG に百分率座標で描いた `<circle r="4">`**: Chromium と WebKit の両方で 8×8 になった。
  - **Chromium の `getBoundingClientRect`**: SVG の図形に対して、線の太さを含まない箱を返す。長さ 0 の line は 0×0 になり、`viewport.ts` の横はみ出し検査の母数から外れる。polyline も端の丸みを含まない（幅 190 に対し、描画は 198）。circle は 8×8 として母数に入る。
  - **Base UI の隠し radio**（`RadioRoot.mjs`）: name を渡さないとき、インライン style `visuallyHidden` を持つ（clip-path・position:fixed・top:0・left:0 など）。data-slot も class も持たない。
  - **`RadioGroup` の Props**: `Props<TValue = any>` なので、値の型は `unknown` ではなく `any` になる。`(value: unknown) => …` は代入できる。数値の value は、隠し input に文字列 "7" として入る。選択の判定は厳密比較なので、数値同士で一致する。
  - **tailwind-merge 3.6.0**: `has-[>[data-slot=field]]:w-fit` を渡すと、既定の `has-[>[data-slot=field]]:w-full` だけが消える。
  - **Tailwind 4.3.3**: stroke-linecap・stroke-linejoin・vector-effect のユーティリティを持たない。
- **Implications**: 決定 D2・D3・D4・D6 を改め、design の Testing Strategy に次を足した。
  - style の検査は範囲を限る
  - 札ごとのクリック試験
  - 44px の実測
  - WebKit での実描画の記録
  - 一貫性の変異を 4 通りにする

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|---|---|---|---|---|
| A. 手元で絞るクライアント合成（採用） | 取得済みの応答を、純関数で窓・要約・系列へ導き、部品の state で切り替える | 再取得・書込・URL の変更が原理的に起きない。純関数は node で試験できる | 状態は開き直すと消える（要件 2.9 と 4.11 はそれを求めている） | 既存の「クライアント合成シェル」に倣う |
| B. URL クエリとリンク | `?period=7&metric=rating` のリンクで切り替える | 入力要素が 0 件のまま | `useEffect([])` の作りのため、押すたびに全体を読み込み直して再取得する。状態が URL に残る（要件 7.3 に反する）。検索は実現できない | 不採用 |
| C. dashboard-web に置く | 管理画面に同等の画面を作る | 店舗詳細の契約を変えずに済む | オーナーはログインできない。requirements §8.2 の第 2 フェーズに当たる | ユーザー決定で不採用 |

## Design Decisions

### Decision D1: 1 つの窓から 4 つの表示を導く
- **Context**: 要件 3.1〜3.8。グラフ・期間要約・表・現在値を食い違わせない。
- **Alternatives Considered**:
  1. 表示ごとに trend を絞る（表示ごとに境界の計算が重複する）
  2. 窓を 1 回だけ切り出し、4 つへ配る
- **Selected Approach**: 2 を採る。純関数 `selectTrendWindow(trend, periodDays)` の結果だけを、4 つの表示が受け取る。
  - 終点は推移の最新の記録日とする。窓は「終点を含めて遡った暦日 N 日」（`capturedOn > 終点 − N 日`）。
  - 日付は `YYYY-MM-DD` を `Date.UTC` で日数に直して比べる。実行環境のタイムゾーンに依存しない。
- **Rationale**: 境界の計算を 1 箇所に集めれば、要件 9.3 の変異（1 つの導出だけをずらす）が確実に赤になる。
- **Trade-offs**: 「今日」は窓の終点に使わない。そのため、バッチが止まった日は古い終点のまま表示される。現在値に日付を添えることで補う（要件 3.6）。
- **Follow-up**: #268（PR #269）が API 側の基準日を JST に直す。窓はそれに依存せず、取得済みのデータだけから決まる。

### Decision D2: 描画は「図形は伸縮する SVG、文字は HTML」
- **Context**: 要件 6.5（文字を縮めない）、6.1（320px）、1.11・1.12（目盛り・日付・最新値）。
- **Alternatives Considered**:
  1. ResizeObserver で実際の幅を測り、viewBox へ反映する（SVG の text が使える。ただし 2 回描画になり、jsdom 用の代替も要る）
  2. viewBox の幅を固定して SVG ごと伸縮させる（文字が 0.8〜1.2 倍に伸び縮みする）
  3. 図形は `preserveAspectRatio="none"` と `vector-effect: non-scaling-stroke` で伸縮させ、文字は HTML で百分率の位置に置く
- **Selected Approach**: 3 を採る（2026-09-13 の design 検証で、点の描き方を改めた）。
  - 線と罫線は、viewBox を持つ SVG（線の層）に `non-scaling-stroke` で描く。
  - 点と端点の輪は、viewBox を持たない 2 枚目の SVG（点の層）を同じ箱に重ね、`<circle cx="x%" cy="y%" r="4">` で描く。
  - 当初案（長さ 0 の線分を丸い端で描く）は、WebKit で楕円になることを実測したため捨てた（上の「design 検証での実測」）。
  - 目盛りと最新値は、描画領域に対する百分率で絶対配置する。`style` 属性に書くのは、`top` / `left` の百分率だけとする。
  - 線の太さ・端・角・vector-effect は、SVG の属性で書く。
  - 日付の帯は描画領域の外（下）に置き、容器の高さはそれを含めて内容に従わせる。
- **Rationale**: 幅を測らないので 1 回で描け、jsdom でも幾何が決まる。CSS のトークン段（`text-xs`）の文字を、そのまま使える。circle は 2 つの描画エンジンで真円になり、bounding box も 8×8 として横はみ出しの検査に入る。
- **Trade-offs**:
  - 面のコードが `style` 属性を書くのは、これが初めてになる（Base UI の隠し input は、すでにインライン style を持つ）。そこで、書いてよいプロパティを、グラフの figure の範囲に限った許可リストで固定する。
  - SVG が 2 枚になる。どちらも同じ描画領域の箱に `absolute inset-0` で重ねる。
- **Follow-up**: 実描画で、点が真円であることと、端点の輪が線に重なっても判読できることを、Chromium と WebKit の両方で確かめる（要件 9.5）。

### Decision D3: 指標ごとの縦軸（二重軸を作らない）
- **Selected Approach**:
  - **順位**: 上端を 1 位に固定する反転軸にする。下端は、期間内の最大順位と当日の母数（`summary.rankTotal`）の大きい方とする。母数が null のときは最大順位だけで決め、どちらの場合も 2 以上にする。
    - 目盛りは 1 と下端を必ず含む。間は、切りのよい間隔の倍数で埋める。下端に近すぎる中間の目盛り（間隔の半分未満）は落とす。
  - **評価**: 0.5 刻みで丸めた範囲にする。幅が 1.0 未満なら中央から 1.0 へ広げ、1.0〜5.0 の中へ平行移動する。目盛りは幅が 2.0 以下なら 0.5 刻み、それより広ければ 1.0 刻み。
  - **クチコミ数**: 間隔を 1・2・5 × 10^k から選び、区間が 4 つ以下になるようにする。範囲はその倍数に丸める。値が全部同じなら、上下に 1 間隔ずつ広げる。**下端は 0 で止める**。全日 0 件の店（評価の無い新しい店）に負の目盛りを出さないためで、design 検証で追加した。
- **Rationale**: 要件 1.2〜1.5 に対応する。評価で最小の幅を 1.0 にするのは、小数第 1 位の変化が縦幅いっぱいに誇張されるのを防ぐためである。

### Decision D4: 印は「端点・孤立点」を基本とし、日数が少ないときだけ全点に置く
- **Context**:
  - dataviz は印を 8px 以上にするよう求める。
  - 30 日の窓は、320px 幅だと点の間隔が約 7px になる。8px の印と 2px の輪を全点に置くと重なる。
  - 値の無い日で線が途切れると、前後と結ばれない 1 日分の値は、印が無ければ見えなくなる。
- **Selected Approach**:
  - 常に印を置くのは次の 2 つ: 期間内の最新の値（端点。8px と地色の輪 2px）と、前後どちらとも線で結ばれない値（孤立点。8px）。
  - 描く日数が 10 日以下なら、すべての記録日に 8px の印を置く。横軸は公称の期間（終点 − N + 1 〜 終点）に固定するので、描く日数は期間の日数に一致する。現行の選択肢では、7 日は全点、30 日は端点と孤立点だけになる。
  - 10 日の根拠: 320px 幅での描画領域は約 190px ある。10 日（区間 9）だと点の間隔は約 21px になり、印と輪の合計 12px を置いても隙間が残る。circle は WebKit でも真円なので、この見積もりは両エンジンで成り立つ。
- **横軸を公称の期間に固定する理由**（design 検証で確定）: 記録が N 日に満たない店でも、7 日と 30 日の切替で横軸が必ず変わり、記録の無い区間が空白として見える。要件 1.11・5.1 の「期間の始点」は、要件の用語定義（最新の記録日から遡った暦日 N 日）どおりの公称の始点とする。
- **Requirements amendment**: 承認済みの要件 1.6（「各記録日の値を点として描き」）はこの判断と両立しない。そこで 1.6 を上の規則へ改め、1.14（10 日以下は全点）を足す。design の承認ゲートで、この改定を明示する。

### Decision D5: ホバー層（ツールチップ）を持たない
- **Context**: dataviz は、HTML のグラフにホバー層を既定で付けるよう求めている。
- **Selected Approach**: 付けない。理由は 4 つある。
  1. LIFF はスマートフォンの LINE 内ブラウザだけで開く面で、ポインタを重ねる操作が存在しない。
  2. design-language §7.5 が Tooltip を 4 面すべてで禁じている。
  3. 要件 1.13 が、ポインタを重ねたときだけ現れる浮遊表示を禁じている。
  4. dataviz 自身が、ツールチップは補助にとどめるべきとしている。この画面では、同じ値を直下の表と端点のラベルで読める。
- **Trade-offs**: 任意の日の値を点から直接読む手段は無い。表で読む。

### Decision D6: 面の側に置く色の語彙を 4 つに限る
- **Context**:
  - 面の側に色を書かないという規律がある（`page.tsx` 冒頭と design-language §7.8 の「面の側に置く色の閉じた集合」）。
  - グラフの線と罫線には色が要る。
- **Selected Approach**: 使う色は次の 4 つに限る。クラスとしては、塗らない指定の `fill-none` を加えた 6 つになる。
  - 2026-09-16 追記: カードの地色を、塗り（端点の輪）と線（最新値の文字の縁取り）の両方で使うようになったので、クラスは `stroke-card` を加えた 7 つになる。色そのものは 4 つのままである。
  - 本文色 `stroke-current` / `fill-current`: 本文色を継承する。§2.2 の `text` の行（店舗詳細の順位の巨大表示）と同じ色と比である。
  - 区切り線色 `stroke-border`: 罫線。SC 1.4.11 の対象外。
  - カードの地色 `fill-card`: 端点の地色の輪。カードの地色と同じにする。
  - 補助文字色 `text-muted-foreground`: 目盛りと日付。§2.2 の `textMuted` の行と同じ比である。
- この語彙は §7.19 に書く。グラフが実際に使う class を完全一致で固定する検査を足す。
- **Rationale**: 新しい色トークンを足さない（要件の制約）。系列が 1 つなので、区別のための色の組み合わせ（カテゴリ配色）は要らない。dataviz の配色検査（`validate_palette.js`）の対象外である。

### Decision D7: 構造契約は許可リストで書き換える
- **Selected Approach**:
  - 正常系で許す入力は 2 種類だけとする。
    - `input[type=search][data-slot=input]`: 競合が 2 店以上のとき 1 件
    - `input[type=radio][aria-hidden=true][tabindex="-1"]`: 期間 2 と指標 3 で 5 件
  - 0 件を保つもの:
    - `form`、`button`、`textarea`、`select`、`[contenteditable]`
    - 操作系の role（button / textbox / combobox / checkbox / switch / slider / spinbutton）
      - 2026-09-14 追記: searchbox / listbox / option / menu / menuitem / menuitemcheckbox / menuitemradio / tab / treeitem の 9 種を加えた。タスク 1.3 の独立レビューで、自前の `div role="searchbox"` が許可リストの外の入力として要件 7.2 をすり抜けると分かったためである。radio と radiogroup は、選択肢の札が描くので含めない。正典は design.md の「構造契約（改定後）」。
    - `[form]`、`input[name]`
    - 許可リストの外にある `input`
  - 読み込み中・失敗・選択待ちの 3 分岐は、入力 0 件のまま据え置く。
  - 操作した後にも、次を検査する。
    - fetch の回数と対象
    - Storage・cookie への書き込み
    - `history.pushState` / `replaceState`
    - `location.href`
- **Rationale**: 書込の手段が無いことを、要素の種類と振る舞いの両面から固定する。許可リストなので、将来ほかの入力を足せば必ず赤になる。

### Decision D8: 状態はその節の部品が持つ
- **Selected Approach**:
  - 期間と指標は推移の節（`TrendSection`）の `useState` が持つ。検索語は競合の節（`CompetitorsSection`）の `useState` が持つ。
  - ページ全体の状態（`ViewState`）には入れない。URL にも Storage にも書かない。
- **Rationale**: 2 つの状態は互いに独立していて、どちらもほかの節へ影響しない（要件 3.8・4.10）。持ち上げる理由が無い。

## Synthesis

- **Generalization**: 期間の窓・要約・系列は、「1 つの窓から見え方を導く」という同じ問題の変種である（D1）。インターフェイスは窓を中心に据える。一方で、実装は要件にある 3 つの指標と 2 つの期間に限る。
- **Build vs. Adopt**:
  - チャートライブラリ（recharts・visx など）は使わない。制約で外部依存を足せないうえ、1 系列 30 点に対してライブラリは過大で、`preserveAspectRatio` の組み立ても自前で書くほうが小さい。
  - 部品は `@fwlm/ui` の RadioGroup / Field / Input / Card / EmptyState / Table を再利用し、新しい部品は足さない。
  - 検索の正規化は、プラットフォームの `String.prototype.normalize('NFKC')` と `toLowerCase` で済む。自前で書くのは、カタカナをひらがなへ畳み込む処理（コード位置を 0x60 ずらす）だけである。
- **Simplification**:
  - 純関数は 3 つのモジュールにする。窓と要約（`trend-view`）、軸と幾何（`trend-scale`）、検索（`competitor-filter`）。表示の部品は 3 つにする（グラフ・切替・検索欄）。
  - 節の合成は `page.tsx` に残す。`Metric` などの共有の小部品は移動しない。
  - 検索欄の件数表示は常に同じ書式にする（「競合N店のうちM店を表示」）。

## Risks & Mitigations
- **既存テストの文字列の一意性**: `getByText` と e2e の strict な部分一致が二重に当たるおそれがある（「★4.5」「近隣24店中」「Google 評価」「表示期間の変化」「自店の評価」「新着クチコミ」）。
  - 対策: グラフの文言にこれらを含めない。最新値のラベルは値だけにし、先頭に「★」を付けない。
- **`check-design-tokens.sh` の hex 誤検出**: 前置なしの `#265` や、hex に見える SVG の id が検出される。
  - 対策: コメントは「Issue #265」と書く。id は `useId()` の値だけを使い、手書きの id を置かない。
- **`app-integration.test.ts` の禁止リテラル**: store-detail のテストとコメントも走査対象である。禁止リテラルは `bg-primary`・`bg-card`・`field-sizing-content`・`animate-spin`・`outline-none`、単独の語 `dark`。
  - 対策: tasks の各項目に明記する。
- **Base UI RadioGroup の jsdom での操作**: クリックは PointerEvent の互換実装で通る。矢印キーは jsdom では確かめられない可能性がある。
  - 対策: キーボード操作は e2e の実ブラウザで検査する（要件 2.7・5.5）。
- **描画エンジン差**: e2e は Chromium だけで、iOS の LINE 内ブラウザは WebKit である。長さ 0 の線分の丸い端のように、片方のエンジンでだけ壊れる描き方は CI が緑のまま出荷される（design 検証で実測）。
  - 対策: 点は circle で描く。要件 9.5 の実描画の記録を、Chromium と WebKit の両方で行う。
- **同一 URL の後続状態の監査漏れ**: 過去に 2 面の監査漏れがあった（メモリ a11y-audit-misses-successor-states）。
  - 対策: 4 状態の一覧を e2e の fixture に置き、件数を完全一致で固定する。

## References
- dataviz スキル（`references/marks-and-anatomy.md`・`interaction.md`・`anti-patterns.md`）: 記号仕様とアンチパターン
- modern-web-guidance: `accessibility`（インライン SVG の `role="img"`、複雑な図は `figure` / `figcaption`、表の併置）、`forms`（排他の選択肢が 1〜5 個なら常に見えるラジオにする）、live region（検索結果の件数は `polite`）
- [SVG 2 — zero-length subpaths with round caps](https://www.w3.org/TR/SVG2/painting.html#LineCaps): 当初案（点を長さ 0 の線分で描く）の根拠。仕様上は描かれるが、WebKit は伸縮した viewBox の中で楕円に歪める（実測）。そのため当初案は捨てた
- `.kiro/specs/ui-a11y-gaps/design.md`: 44px はラベル行で満たす
- `docs/design/design-language.md` §2.2・§7.2・§7.5・§7.7・§7.8・§7.17・§8

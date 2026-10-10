# AI 下書きの事実性評価（Issue #132）

`review-acquisition` の Requirement 3.2 に対する遵守度を、実 Gemini の出力で測るための評価一式。

> **Requirement 3.2**: The 本システム shall 素材に含まれない体験・事実・固有名詞を下書きに含めない（客本人が選んだ事実のみを書く）

## なぜ必要か

起票時（2026-08-16）、事実性は **プロンプトの指示だけ** に依存していた。出力検証（`generator.ts` の `extractDraft`）は JSON 形式・非空・文字数しか見ず内容を検証しておらず、既存テストも「プロンプトの組み立て」と「モック応答の取り扱い」しか見ないため、**実モデルが指示を守っているかを確かめる経路がどこにも無かった**。実測は 63.9%（雰囲気に限れば 70.4%）だった。

現在は案A（プロンプトでの名指し禁止）と案B（生成後の事後検証）の 2 層で守っている。**それでも本評価は必要である。** どちらの層もモデルの出力次第で効き方が変わり、語彙の限界もあるため、実際の逸脱率は測らなければ分からない。プロンプトやモデルを変えたときに、効果を同じ物差しで比較するための基盤でもある。

## 何を測るか

Requirement 3.2 の違反のうち、**客が選ばなかった評価軸について書いた** ケースに限定して機械判定する。客の選択という明確な境界があるため、逸脱かどうかで争いが起きないからである。

測っているのは **逸脱率の下限** である。語彙は「明確にその軸を名指しする語」だけに絞ってあり、曖昧な語（`美味しい` など）は意図的に外している。したがって検出漏れは構造的に存在するが、**検出したものは確実に逸脱** である。

スコープ外（第一段階では測らない）:

- 評価軸に紐づかない創作（例「丁寧に淹れられた一杯」「静かな店内」）
- 素材の言い換えを超えた敷衍（例「美味しい」→「一口飲むと香りが広がる」）

### 第二の軸: 来店の経緯・動機の創作（Issue #254）

アンケートは来店の経緯・動機・同行者・来店歴を一切尋ねない。したがって一言に書かれていない限り、下書きに現れたら創作である。
本番 E2E（2026-09-13）で「〇〇駅前を通る際に立ち寄りました」「雰囲気を目当てに訪れましたが」が観測され、上の軸では 1 件も拾えなかったため、別の軸として数える。

- 検出は `../src/lib/draft/visit-context.ts`（語彙は `visit-context-lexicon.json`）。第一の軸と同じく、明確に過去の来店の事情を述べる形だけを拾い、将来の意向（「また立ち寄りたい」）や性質の描写（「家族と来ても楽しめる」）は拾わない。**測っているのは下限**である
- レポートは、この軸の創作率と、**書き出し・切り口・文体の候補ごと**の内訳（両方の軸）を出す。候補の指示が素材に無い情報を求めていれば、その候補だけ率が跳ねる
- 候補を足したときの副作用として、**星の数の読み上げ**（「評価は5点です」）、**「無かった」の断定**（Issue #414 で良かった点以外へ広げた。下の節を参照）、**字数の規則の下限を割った本数**も候補ごとに数える（#254 の独立レビューで、新しい書き出しが前 2 つを生んだ）。多様性は先頭 10 字の重複率では足りない（先頭は店名になりやすい）ので、店名を除いた本文で比べること

### 第三の軸: 素材に無い固有名詞・数値・日付（Issue #222）

Requirement 3.2 が名指しする「素材に含まれない**固有名詞**」と、素材に無い数値・日付を数える。上の 2 軸はこれらを 1 件も拾えない。一方で、Google の 2026-04 改定が禁止の実体として名指しする「実体験に基づかないコンテンツ」として読まれうる形である。

- 検出は `../src/lib/draft/material-grounding.ts`（語彙は `material-grounding-lexicon.json`）。形態素解析や LLM 判定は使わず、正規表現と語彙で決定的に判定する。外部依存を持たず、検出器の正しさを CI で両方向に固定するためである。**測っているのは下限**である
- 軸は 3 つで、レポートも軸ごとに分けて出す（既存の軸の数値は、拡張の前後でそのまま比較できる）
  - **固有名詞**: 駅名・商店街（`place`）、「〇〇さん」（`person`）、英字の語（`latin`）、料理・飲み物の語彙（`dish`）。名前が素材（店名・一言）に含まれれば数えない。店名の「カフェ」「COFFEE」はコーヒーの手がかりとして扱う。実在店の品名（「一蘭 渋谷店」のラーメン）は手がかりが無いので拾う。これはモデルの事前知識の混入で、架空店名と実在店名の対比で見たいものそのものである
  - **数値**: 算用数字の値が素材に無ければ数える（一言「40分ほど」から下書き「40分」は数えない）。星の数の読み上げは既存の別軸なので除く。日付・時刻の数字は日付の軸へ回す
  - **日付・時刻**: 「先週末」「先日」、月日・曜日・年中行事、「12時頃」「ランチタイムに」など。一言に同じ分類の手がかりがあれば数えない（意味論は第二の軸と同じ。過去形の後置条件 `PAST` は第二の軸の語彙と同一であることをテストが機械照合する）
- 店名は素材そのものなので、下書きから店名を取り除いてから走査する
- 既知の限界（漢数字・語彙に無い料理名・ひらがなや漢字だけの名前など）は語彙ファイルの `_comment` に書いてある
- **初回の実測（2026-09-28・gemini-3.1-flash-lite・案A+B・20 素材 × 3 回）**: 固有名詞 1/60（「煮込み料理」）、数値 0/60、日付・時刻 0/60。拾った実例と 60 件全文を目で読み、誤検出は 0 件だった。一言にある「40分ほど」「3分ほど」、店名に由来する「中目黒駅」「COFFEE」は正しく数えていない。「煮込み」は、この実測で取りこぼしに気づいて語彙へ足した。数値は足した後の検出器を保存済みの 60 件に当て直したもの

### 第四の軸: 素材の外から補った属性・事前の期待・再訪の意向（Issue #339）

本番 E2E（2026-09-25）で、星 1・良かった点「雰囲気」・気になった点「雰囲気」・一言なしという素材から、「開放的で落ち着いた雰囲気」「コーヒーの香り漂う空間」「期待して伺いました」「改めて様子を見てみたい」が生成された。上の 3 軸はこれを 1 件も拾えない。第一の軸は**客が選ばなかった**観点しか見ないので、選んだ観点をどう書いたかは見ない。第二の軸は過去の来店の事情だけを数え、将来の意向は設計上数えない。

- 検出は `../src/lib/draft/embellishment.ts`（語彙は `embellishment-lexicon.json`）。語彙の形式と一言による除外の意味論は第二の軸と同じで、検出ロジックも第二の軸のものをそのまま使う。**測っているのは下限**である
- 分類:
  - `expectation`: 来店前の期待（「期待して伺いました」「期待していた通りには」「期待以上」）
  - `intention`: 再訪の意向（「またぜひ立ち寄りたい」「改めて〜してみたい」）
  - `attribute:<観点>`: 観点の具体的な属性・状態（「開放的」「香り漂う」「濃厚」「笑顔」）。評価の言い換え（「丁寧」「リーズナブル」）は数えない
- 属性は、その観点を客が選んだ素材かどうかに分けてレポートする。#339 が問題にしたのは**選んだ観点**の属性である
- 来店の動機「惹かれて」は、#339 で第二の軸の motive に足した（第二の軸の語彙漏れだったため）
- 再現ケースは `atmosphere-both-sides-star1`。同じ厚み（観点あり・一言なし）の対照は `taste-only-star5` / `service-only-star4` / `taste-both-sides-star3`
- 対照は第三の軸と同じ自己照合である。下書き自身を一言として渡すと、本文に当たったパターンは一言にも当たるので、どの分類も構造的に 0 件になる。実測テストはこれを assert する
- **初回の実測（2026-09-30・gemini-3.1-flash-lite・事後検証なし・21 素材 × 6 回）**: 変更前 69/126 → #339 のプロンプト修正後 15/126。再現ケースは 7 素材 × 15 回の計測で 10/15 → 0/15。構成ごとの表・既存の軸への影響・検出器の訂正は `.kiro/specs/review-acquisition/tasks.md` の「Issue #339 の実測記録」にある

### 「無かった」の断定（Issue #414 で広げた）

アンケートは観点を選ばせるだけで、選ばなかったことは無かったことではない。#254 のレビューで置いた当初の検出は「良かった点は特にありません」の形だけを見ていた。#339 の本番確認で「その他の要素についての特筆すべき事項は特にない」が見つかり、この形を 0 件と数えていたことが分かったので、検出器を `../src/lib/draft/absence.ts`（語彙は `absence-lexicon.json`）へ移して広げた。

- 分類: `goodPoints`（良かった点の不在）/ `concerns`（気になった点の不在。高評価の素材で出る）/ `others`（その他の不在と、素材そのものへの言及「特に記載する項目がありませんでした」）
- 当初のパターンは `goodPoints` の最初のパターンとして文字列を変えずに残した。#414 より前の実測と比べるときは、このパターンだけの件数を使う
- 評価の低さを述べる文（「満足できる内容ではありませんでした」）と、一言そのもの（「期待していたほどではありませんでした」）は数えない
- **広げた検出器で数え直すと、#339 のプロンプト修正は断定を 6/321 → 14/321 へ増やしていた**（良かった点の不在は 5 → 1 に減り、気になった点の不在 0 → 4 とその他の不在 1 → 9 が増えた）。#339 の記録の「悪化していない」は、狭い物差しによる誤りだった。訂正は `.kiro/specs/review-acquisition/tasks.md` の「Issue #339 の実測記録」の末尾にある
- **#414 の是正（2026-09-30）**: 締めくくりを満足の度合いで述べさせる規則などで、断定は 24/246 → 7/246、再訪の意向は 25/246 → 0/246 になった（全 21 素材 × 6 回＋断定の出やすい 6 素材 × 20 回・事後検証なし）。代わりに下書きは短くなる（字数の規則内 211 → 158）。構成ごとの表は `tasks.md` の「Issue #414 の実測記録」にある

## 実行

**実 Gemini を叩くため従量課金が発生する。CI では走らない。**

```bash
# 本番と同じキーで測る場合（値は表示せずファイル経由で渡すこと）
gcloud secrets versions access latest --secret=gemini-api-key --project=gen-fw-line-meo --out-file=/tmp/gk

GEMINI_API_KEY="$(cat /tmp/gk)" GEMINI_MODEL=gemini-3.1-flash-lite \
  pnpm --filter @fwlm/survey-web run eval:factuality

rm -f /tmp/gk   # 使い終わったら必ず消す
```

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `GEMINI_API_KEY` | （なし） | **未設定なら評価全体が skip される**（通常の `pnpm test` で誤って課金しないため） |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` | 本番 Cloud Run の `survey-web` に配線されている値と揃えること |
| `EVAL_RUNS` | `3` | 素材 1 件あたりの生成回数。母数を増やすときに上げる |
| `EVAL_OUT` | （なし） | 指定するとサンプル全件を JSON で書き出す。**リポジトリ外のパスを指定すること** |
| `EVAL_POSTCHECK` | `1` | `0` にすると案B（生成後の事後検証と作り直し）を外し、**案A 単体**の効果を測る。前後比較の意味を保つために要る |
| `EVAL_OPENING` | （なし） | 書き出しを候補の 1 つに固定する（Issue #254）。候補ごとの創作率を同じ素材で比べるときに使う。候補に無い値は測定の前に止まる。未指定なら本番と同じくランダム |

規模の目安: 素材 21 件 × 3 回 = 63 リクエスト、1 リクエストあたり約 300 トークン。
案B が有効なときは、逸脱を検出した分だけ作り直しの呼び出しが上乗せされる。

## ファイル

| ファイル | 役割 |
|---|---|
| `dataset.json` | 素材セット。少選択・全選択・低評価（理由あり/なし）・高評価（理由あり/なし/抽象的な一言）・架空店名/実店名の対比・気になった点つき（Issue #221: 気になった点だけ／高評価で 1 つ／同じ観点を両群で選択）・#339 の再現ケース（星 1・雰囲気を両群・一言なし）を含む |
| `aspects.json` | 評価軸 code → ラベル。正典は `db/migrations/0002_reference_seed.sql`（写しのずれは自己検証テストが検出する） |
| `factuality.eval.test.ts` | 実測。本番と同一の生成経路（`createDefaultDraftGenerator` + `pickVariation`）を通す |
| `../src/lib/draft/factuality.ts` | 検出の純関数。**案B で本番経路へ移した**（生成器と評価の両方が使う） |
| `../src/lib/draft/aspect-lexicon.json` | 軸ごとの検出語彙。設計方針と既知の限界をファイル内に明記 |
| `../test/factuality-detect.test.ts` | **検出器自身の検証**。実 API 不要で CI で常時走る |
| `../src/lib/draft/visit-context.ts` ／ `visit-context-lexicon.json` | 第二の軸（来店の経緯・動機の創作）の検出と語彙（Issue #254）。正規表現で持ち、語尾で過去の事実と将来の意向を分ける |
| `../test/visit-context-detect.test.ts` | 第二の軸の検出器の検証。観測済みの下書き・陽性例・否定例・全パターンの発火を固定する |
| `../src/lib/draft/material-grounding.ts` ／ `material-grounding-lexicon.json` | 第三の軸（素材に無い固有名詞・数値・日付）の検出と語彙（Issue #222）。星の数の読み上げの正規表現 `STAR_NARRATION` もここに置く（数値の軸と共有するため） |
| `../test/material-grounding-detect.test.ts` | 第三の軸の検出器の検証。観測済みの下書き・軸ごとの陽性例と否定例・全パターンと全語彙の発火・一言による除外の対照・自己照合の対照を固定する |
| `../src/lib/draft/embellishment.ts` ／ `embellishment-lexicon.json` | 第四の軸（素材の外から補った属性・事前の期待・再訪の意向）の検出と語彙（Issue #339）。検出は第二の軸の関数を使い、分類名の約束（`attribute:<観点>`）と店名の除去だけを持つ。**`expectation` の分類は本番の事後検証にも入る**（Issue #413） |
| `../src/lib/draft/absence.ts` ／ `absence-lexicon.json` | 「無かった」の断定の検出と語彙（Issue #414）。検出は第二の軸の関数を使い、分類の約束だけを持つ。**本番の事後検証にも入る**（Issue #413） |
| `../test/absence-detect.test.ts` | 断定の検出器の検証。本番の観測例・分類ごとの陽性例と否定例・全パターンの発火・一言による除外・当初のパターンの文字列を固定する |
| `../test/embellishment-detect.test.ts` | 第四の軸の検出器の検証。#339 の観測例・分類ごとの陽性例と否定例・全パターンの発火・観点ごとの一言の除外・店名の除去を固定する |

最後の 2 つを分けているのが要点である。実測はキーが無いと skip されるので、検出器が壊れても「実行されないだけ」で気づけない。検出器の正しさは独立に、CI が常に走る側で固定する。

## 対照群

`all-selected-star5`（全 6 軸を選択した素材）は、選ばれなかった軸が存在しないため検出は構造的に 0 件になる。ここが 0 でなければ検出器か実行経路が壊れており、**測定結果全体が信用できない**。実測テストはこれを assert している。

第三の軸（固有名詞・数値・日付）では、この素材は対照にならない。全観点を選んでも、モデルは数値や日付を創作しうるからである。代わりに**自己照合の対照**を置く。全サンプルについて、下書き自身を一言として渡して同じ検出器を通す。本文に現れたものはすべて素材に含まれることになるので、どの軸も構造的に 0 件になる。実測テストは軸ごとにこれを assert する。0 でなければ、素材との照合の経路が壊れている。

## 是正の構成（測り分け）

現在の本番は 2 層で守っている。

| 層 | 内容 | 実装 |
|---|---|---|
| 案A | 客が選ばなかった観点をプロンプトで名指し禁止する | `src/lib/draft/prompt.ts` |
| 案B | 生成後に言及を検出したら **1 回だけ**作り直す。なお残れば下書きは返しログに記録 | `src/lib/draft/generator.ts` |

案B は Issue #413 で、来店前の期待（`embellishment.ts` の `expectation`）と「無かった」の断定（`absence.ts`）へ広げた。いずれかを検出したら 1 回だけ作り直し、残れば `fabrication_residual` として記録する（未選択の観点の `factuality_residual` とは事象名を分けた）。

実測（2026-09-30・事後検証あり・246 件）では、来店前の期待が 6 → 0、断定が 4 → 0 になった。作り直しの発生は約 4.9% である（`.kiro/specs/review-acquisition/tasks.md` の「Issue #413 の実測記録」）。

`EVAL_POSTCHECK=0` で案B だけを外せる（広げた分も含めて外れる）。**案A 単体と案A+B を同じデータセットで測り分けられる**ようにしてあるのは、どちらがどれだけ効いているかを後から分離できなくなるのを避けるため。

## 結果の扱い

許容水準は **11.1%（案A 適用後の実測値）を受け入れる**ことで合意済み。ゼロは要求しない。案B はその残差をさらに刈るための層であり、作り直してもなお残る場合は下書きを客へ返して `factuality_residual` として記録する（客の Google 投稿導線を殺さない）。

是正案の比較は、**同じデータセットで前後を測って**行うこと。

## structured survey の評価（Issue #440）

structured survey（店舗別の Target・facet・極性・Issue #436 / #438）の回答から作る下書きを、**本番の通常生成が自然で、安全か**を確かめるための評価一式。プロダクトの概念は **通常生成**（Natural LLM Realizer・`src/lib/draft/structured/realizer.ts`）と **safe fallback**（`structuredFallbackDraft`）の 2 つだけで、評価もこの 2 つだけを測る（以前の A/B/C/D の方式比較はやめた。方式比較そのものは目的ではない）。

目的は 2 つあり、片方だけでは足りない。

1. **事実性**: 新しい具体的事実を作らない（hard gate・決定的に判定）
2. **自然さ**: 実際に Google 口コミへ投稿したくなる文章にする。アンケートの読み上げ・safe fallback 風の羅列にしない（主評価は人手の採点・自動の数値は診断）

AI detector は自然さの正解に使わない。

### 生成の方針（自然さ重視）

**新しい具体的事実は創作しない。ただし、回答から自然に導ける主観的・意味を保った膨らませ方は許す。**

| 区分 | 例 |
|---|---|
| 許す: 意味を保った言い換え | 味 →「おいしかった」／接客の丁寧さ →「丁寧に対応してもらえた」／量 →「満足感のある量だった」／居心地 →「居心地よく過ごせた」 |
| 許す: 弱い主観（controlled inference） | 「少し」「やや」「ちょっと」「満足できた」「印象に残った」「過ごしやすかった」「しっかり楽しめた」 |
| 許す: 星からの抽象的な全体の印象 | ★4〜5 →「全体としては満足です」／★1〜2 →「全体としては不満が残りました」（書くなら最後に短く。★3 は渡さない） |
| 許す: 統合・省略・並べ替え | 同じ主題はまとめる・順番を変える・主語を繰り返さない。ただし positive / concern の片側を丸ごと落とさない・料理名は落とさない |
| 許す: 一言の口調 | 「めっちゃよかった！」ならくだけた書き方でよい（人物像は推測しない） |
| 止める: 具体的な事実 | 数値・具体時間（20分）／原因（混雑・人手不足・予約客が多かった）／観測していない属性（新鮮・脂・香ばしい・サクサク）／人物の様子（笑顔・忙しそう・親切そう）／来店の文脈（友人と・デート・ランチ・仕事帰り）／意向（また行きたい・おすすめ）／強い強度（とても・最高・絶対） |
| 止める: 回答に無い対象 | 未回答の Target・facet・カテゴリ。Target だけ（項目の指定なし）の回答は「良かった」「印象に残った」まで（味・量・見た目を補わない） |
| 止める: exact overlap の理由 | 「味について良かった点もあり、気になる点もありました」は通す。「最初は美味しかったが後半は味が落ちた」は止める |

safe fallback は通常の文章ではない。LLM 生成 → runtime hard gate → 作り直し → それでも失格（または生成の失敗）のときだけ返す最後の手段である。

### 構成

| ファイル | 役割 |
|---|---|
| `structured/cases.json` | 固定ケース 13 件（A 単純 positive／B 複数 facet／C 複数 Target／D positive + concern／E 同じ Target・別 facet／F exact overlap／G Target のみ／H カテゴリ全体の facet／I1〜I3 一言あり（硬め・普通・カジュアル）／K 量・接客と入店の待ち時間（読み上げになりやすい典型）／J 情報量が多い）。店名・料理名・一言はすべて架空。ケースごとに、Target の言い方（subjects）・未回答の Target（menuTargets）・一言の内容の語（commentKeywords）・固有の禁止の意味・**許す言い換え**・**失格になるべき例**を持つ |
| `../src/lib/draft/structured/lexicon.json` | hard gate の語彙。**本番の runtime hard gate と eval が同じ語彙・同じ判定を使う**（物差しを 2 つに割らない） |
| `structured/gates.ts` | 固定ケースの読み込み。判定の本体は `../src/lib/draft/structured/gate.ts`（本番と共有）で、ここから再輸出する |
| `structured/methods.ts` | 評価の対象（`production`＝本番の通常生成・作り直しと safe fallback を含む／`safe-fallback`＝事実性の対照） |
| `structured/diagnostics.ts` | 自然さの診断（個々の合否ではない）と再生成の類似度 |
| `structured/report.ts` | 1 本ずつの記録・集計・表と、自動の成功条件（`successChecks`） |
| `structured/rating.ts` | 人手の採点の束と、記入済みの表の集計 |
| `structured/structured.eval.test.ts` | 実測（`production` は `GEMINI_API_KEY` が無ければ skip し、safe fallback だけを流す） |
| `structured/BASELINE.md` | 記録と、最終 PR 前の release gate |
| `../test/structured-eval-gates.test.ts` ／ `../test/structured-eval-tools.test.ts` ／ `../test/structured-runtime-gate.test.ts` | 検出器・境界（許す言い換え / 止める創作）・診断・採点・集計の検証。**実 API 不要で CI で常時走る** |

### hard gate（自然でも、これが起きたら失格）

未回答の Target（`unselectedTarget`）／未回答の facet（`unselectedFacet`）／未回答のカテゴリ（`unselectedCategory`）／新しい具体属性・人物の様子（`newAttribute`）／原因（`cause`）／時間帯（`timing`・`ungrounded:dateTime`）／同行者・来店の経緯と動機（`companion`・`visitContext:*`）／期待（`expectation`）／再訪の意向（`revisit`）／推奨（`recommendation`）／入力に無い **強い** 強度（`intensity`・「少し」「やや」は数えない）／極性の反転（`polarityReversal`）／positive・concern の片側を丸ごと落とす（`positiveDropped`・`concernDropped`）／Target を落とす（`targetDropped`）／exact overlap の理由の創作（`overlapReason`・Issue #418）／一言の内容を別の claim の理由として結ぶ（`commentLinkage`）／「無かった」の断定（`absence`）／素材に無い固有名詞・数値（`ungrounded:*`）／ケース固有の禁止の意味（`caseForbidden:*`）。

一言に同じ意味があれば、その分類は数えない（客が自分で書いたことは素材である・既存の検出器と同じ意味論）。判定は高 precision に倒す。自然な文章まで過剰に弾くと、作り直しと safe fallback が増えて読み上げの文章へ戻るからである。

### runtime hard gate と offline eval gate（Issue #439）

判定の実装は 1 つ（`../src/lib/draft/structured/gate.ts`・語彙は `lexicon.json`）で、本番と評価が同じものを使う。違うのは入力が持つ知識だけである。

| 区分 | どこで | 入力が持つもの | 止め方 |
|---|---|---|---|
| runtime hard gate | 本番の通常生成の事後検証 | 回答の素材・一言・回答時点の定義の未回答の Target の名前（素材の `unselectedTargets`・LLM へは渡さない） | 作り直し → safe fallback |
| offline eval gate | `eval/structured`（最終 PR 前の release gate） | 上に加えて、固定ケースの Target の言い方（`subjects`・`menuTargets[].aliases`）・一言の内容の語（`commentKeywords`）・ケース固有の禁止の意味 | release の判断（runtime が拾えない残差） |
| 人手の採点 | `.rating.md` | （語彙で決まらないもの・自然さ） | release の判断 |

- 未回答の Target: runtime は名前の **完全一致**（NFKC・名前の中の空白の有無を問わない・1 文字の名前は照合しない）だけを拾う。言い換え（「刺身盛り合わせ」→「刺し盛り」）は推測せず、固定ケースの言い方で評価だけが拾う。
- 一言の因果づけ: 一言の語が理由の接続（ので・ため・〜たから など）の **前** にあり、同じ文に別の claim の主題があるときだけ拾う。主題を省いた因果は拾えず、人手の採点で測る。
- **runtime hard gate を通った = 事実どおりの保証ではない。** 語彙の判定は違反の下限で、runtime で止められない残りは offline eval gate と人手の採点で release 前に測る。

### coverage は文字列一致ではない

「刺身盛り合わせ / 味 / positive」は「刺身盛り合わせがおいしかったです」で満たす。判定は文単位で、**主題**（Target の言い方・カテゴリ全体の facet の意味の手がかり）と**極性の手がかり**が同じ文にあるかを見る。主題を省略した文は直前の文の Target を引き継ぐ（全体の印象を述べる文は引き継がない）。facet の意味まで述べたか（`facetMentioned`）は診断に留める（統合・省略を許すため）。

### 自然さの診断（傾向の観察）

safe fallback 風（`fallbackLike`: 「〜良かったです。〜気になりました。」の羅列）・1 文 1 主題の並べ（`subjectPerSentence`・入力の順なら `checklistLike`）・3 字以上の項目名をそのまま書いた割合（`labelVerbatim`）・「良かったです」の反復・同じ語尾の連続・「全体として」「一方で」「好印象」などの句・店名で始める率・再訪 / 推奨で締める率・星の読み上げ・一言より感嘆符が増えたか・字数（1 claim あたり・最長）・同じ入力の再生成の類似度。`production` は **LLM の文だけ**で集計する（safe fallback に落ちた文は除く）。

### 成功条件（最終 PR 前）

自動（`report.ts` の `successChecks`・実測の表の末尾に PASS / FAIL で出る）:

| 条件 | 目安 |
|---|---|
| offline eval gate の失格（runtime を通った最終の下書きの残差） | 0 件 |
| exact overlap の理由の創作 | 0 件 |
| safe fallback に落ちた率 | ≤ 10% |
| 通常生成の文が safe fallback 風 | ≤ 5% |
| 3 主題以上を入力の順に 1 文 1 主題で読み上げた | ≤ 10% |
| 同じ文末が 3 文続いた | ≤ 5% |
| 1 claim あたりの平均字数 / 最長 | ≤ 45 字 / ≤ 250 字 |
| 同じケースの再生成が完全一致した組 | 0 組 |

人手（`.rating.md` と `.ratings.csv`・**評価者 2 名以上**・`rating.ts` の `aggregateRatings` で集計）:

| 条件 | 目安 |
|---|---|
| 創作の指摘（`fabrication` = 1） | 0 件 |
| 自然さ（naturalness）の平均 | ≥ 4.0（評価者ごとにも ≥ 3.5） |
| 投稿しやすさ（postability）の平均 | ≥ 4.0 |
| 内容の忠実さ（fidelity）の平均 | ≥ 4.5 |

FAIL があれば、まず語彙の誤検出（自然な文を落としていないか）と、プロンプトの指示を見直す。目安は今回の方針で置いた初期値で、実測で根拠が揃えば BASELINE.md に理由を残して改める。

### 人手の採点

`EVAL_OUT` を指定すると、その隣に次を書き出す（すべてリポジトリの外）。

| ファイル | 中身 |
|---|---|
| `<EVAL_OUT>.rating.md` | ケースごとに、本番の通常生成の最終の下書きを `S1`・`S2`… の符号で並べた採点用の本文（LLM の文か safe fallback の文かは出さない） |
| `<EVAL_OUT>.ratings.csv` | 自然さ・投稿しやすさ・内容の忠実さ（各 1〜5）と、創作の有無（0 / 1）の記入表 |

評価者は `R1` のような符号だけで記録し、名前などの個人情報をリポジトリへ入れない。評価者ごとに表を複製して記入し、行を連結して `aggregateRatings` で全体・評価者ごとの平均へ集計する。

### 実行

```bash
# キーなし: safe fallback だけを流し、検出器と集計の経路を確かめる
EVAL_OUT=/tmp/structured-eval.json pnpm --filter @fwlm/survey-web run eval:structured
```

#### 実 Gemini で本番の通常生成を測る（最終 PR 前の release gate）

使うのは **自分の開発用の `GEMINI_API_KEY`** である。本番のシークレット（Secret Manager）からは取らない。キーは `.env` / `.env.local`・リポジトリ・ログ・`EVAL_OUT` の出力・シェルの履歴のどこにも残さない（入力を表示しないプロンプトで受け、その 1 コマンドの環境にだけ渡す）。`ts/` で実行する。

Git Bash（Windows）/ bash:

```bash
read -rsp 'GEMINI_API_KEY: ' GEMINI_API_KEY; echo   # 入力は表示されず、履歴にも残らない（export しない）
GEMINI_API_KEY="$GEMINI_API_KEY" GEMINI_MODEL=gemini-3.1-flash-lite EVAL_RUNS=3 \
  EVAL_OUT="$HOME/fwlm-eval/$(date +%Y%m%d-%H%M)/structured.json" \
  pnpm --filter @fwlm/survey-web run eval:structured
unset GEMINI_API_KEY
```

PowerShell:

```powershell
$sec = Read-Host -AsSecureString 'GEMINI_API_KEY'   # 入力は表示されず、PSReadLine の履歴にも残らない
try {
  $env:GEMINI_API_KEY = [System.Net.NetworkCredential]::new('', $sec).Password
  $env:GEMINI_MODEL = 'gemini-3.1-flash-lite'; $env:EVAL_RUNS = '3'
  $env:EVAL_OUT = "$env:LOCALAPPDATA\fwlm-eval\$(Get-Date -Format yyyyMMdd-HHmm)\structured.json"
  pnpm --filter @fwlm/survey-web run eval:structured
} finally {
  Remove-Item Env:GEMINI_API_KEY, Env:GEMINI_MODEL, Env:EVAL_RUNS, Env:EVAL_OUT -ErrorAction SilentlyContinue
  Remove-Variable sec
}
```

- まず 5 ケースだけ試すなら `EVAL_CASES=K-everyday-mix,A-simple-positive,B-multi-facet,D-positive-and-concern,F-exact-overlap` を足す（ローカル確認の 5 ケースと同じ素材）。
- `EVAL_OUT` の親ディレクトリは無ければ作る。リポジトリの中を指すと止まる。出力（下書きの全件と採点の束）にキーは入らない。
- 画面には集計の表・成功条件の PASS / FAIL・通常生成の経路の内訳（作り直し・safe fallback の本数）が出る。**通常生成が全件失敗した（キー・モデル名・通信の誤り）ときは赤になる**（safe fallback の文だけで測ったことにしない）。
- 終わったら、集計だけを `structured/BASELINE.md` の §2 の表へ写す。実出力はリポジトリへ入れない。

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `GEMINI_API_KEY` | （なし） | 無ければ `production` を skip する（safe fallback だけを流す） |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` | 本番と揃える |
| `EVAL_RUNS` | `3` | ケース 1 件あたりの回数（再生成の類似度にも使う） |
| `EVAL_CASES` | （全ケース） | ケースの id をカンマ区切りで絞る |
| `EVAL_OUT` | （なし） | サンプル全件と集計を JSON で書き出し、隣に採点の束を置く。**リポジトリの外のパスでなければ止まる** |

規模の目安: 13 ケース × 3 回。1 本あたり最大 2 リクエスト（初回が runtime hard gate を落ちたときの作り直し）なので、合計 39〜78 リクエスト。

`eval:factuality`（legacy の評価）は従来どおり `factuality.eval.test.ts` だけを流す。

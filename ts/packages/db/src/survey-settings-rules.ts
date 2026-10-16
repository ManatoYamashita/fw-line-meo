// 店舗オーナーが編集するアンケート設定の入力規則（Issue #437）。
//
// **規則の値はここ 1 箇所だけに持つ。** サーバー（@fwlm/db の survey-settings.ts と store-detail の API）が
// 強制し、設定画面（store-detail のクライアント）は同じ値で入力欄の上限や追加ボタンの可否を描く。
// 画面の側の検証は案内のためで、受け付けるかどうかはサーバーが決める。
//
// このモジュールはクライアントにも同梱されるので、値の import を 1 つも持たない（pg を持ち込まない・
// ts/eslint.config.js が機械強制する）。上限は利用テストで見直す運用値なので DB の CHECK には書かない
// （db/migrations/0015 の store_survey_targets の注記を参照）。

/** オーナーが Target（料理名・ドリンク名）を登録できるカテゴリと、active な Target の上限件数。 */
export const ACTIVE_TARGET_LIMITS = {
  food: 10,
  drink: 10,
} as const;

export type OwnerTargetCategoryCode = keyof typeof ACTIVE_TARGET_LIMITS;

export const OWNER_TARGET_CATEGORY_CODES: readonly OwnerTargetCategoryCode[] = ['food', 'drink'];

export function isOwnerTargetCategoryCode(code: unknown): code is OwnerTargetCategoryCode {
  return typeof code === 'string' && (OWNER_TARGET_CATEGORY_CODES as readonly string[]).includes(code);
}

/**
 * オーナーが表示 / 非表示を切り替えられるカテゴリ。
 *
 * MVP では予約・来店だけである（#435: 予約を受けない店舗がある）。料理や接客を消せると、客が選べる
 * 観点が店舗の都合で削られる。広げるときはこの配列へ足す（API・画面・権限の形は変えなくてよい）。
 */
export const OWNER_TOGGLEABLE_CATEGORY_CODES: readonly string[] = ['reservation_visit'];

export function isOwnerToggleableCategoryCode(code: unknown): code is string {
  return typeof code === 'string' && OWNER_TOGGLEABLE_CATEGORY_CODES.includes(code);
}

/** Target 名の最大文字数（前後の空白を除いた後の、Unicode のコードポイント数）。 */
export const TARGET_LABEL_MAX_LENGTH = 40;

export type TargetLabelError =
  /** 文字列ではない。 */
  | 'LABEL_INVALID'
  /** 前後の空白を除くと空。 */
  | 'LABEL_EMPTY'
  /** TARGET_LABEL_MAX_LENGTH を超える。 */
  | 'LABEL_TOO_LONG'
  /** 改行を含む。 */
  | 'LABEL_MULTILINE'
  /** 制御文字・区切り文字・壊れた文字を含む。 */
  | 'LABEL_INVALID_CHARACTER'
  /** 評価・おすすめ・再訪の言葉を含む（TARGET_LABEL_EVALUATIVE_PATTERNS）。 */
  | 'LABEL_EVALUATIVE';

export type TargetLabelResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: TargetLabelError };

const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/u;
// 制御文字（Cc）と、行・段落の区切り（Zl / Zp）と、置換文字（U+FFFD）。DB の CHECK（[[:cntrl:]]）より広い。
// 置換文字は、送り手が UTF-8 以外で送った文字列を読めなかった跡である（名前として登録すると文字化けが残る）。
const INVALID_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}\uFFFD]/u;
// \u66F8\u5F0F\u6587\u5B57\uFF08Unicode \u306E Cf: \u30BC\u30ED\u5E45\u30B9\u30DA\u30FC\u30B9 U+200B\u30FB\u30BD\u30D5\u30C8\u30CF\u30A4\u30D5\u30F3\u30FB\u65B9\u5411\u5236\u5FA1\u306A\u3069\uFF09\u3002\u898B\u3048\u306A\u3044\u307E\u307E\u8A9E\u3092\u533A\u5207\u308C\u308B\u306E\u3067\u3001
// \u8A55\u4FA1\u8A9E\u306E\u5224\u5B9A\u3092\u3059\u308A\u629C\u3051\u308B\u624B\u6BB5\u306B\u306A\u308B\uFF08PR #443 \u306E\u8FFD\u52A0\u30EC\u30D3\u30E5\u30FC\uFF09\u3002\u6599\u7406\u540D\u306B\u5165\u308C\u308B\u7406\u7531\u306F\u7121\u3044\u306E\u3067\u62D2\u5426\u3059\u308B\u3002
// \u4F8B\u5916\u306F\u7D75\u6587\u5B57\u3069\u3046\u3057\u3092\u7E4B\u3050\u30BC\u30ED\u5E45\u63A5\u5408\u5B50\uFF08U+200D\u30FB\uD83D\uDC68\u200D\uD83C\uDF73 \u306E\u3088\u3046\u306A\u5408\u6210\u7D75\u6587\u5B57\uFF09\u3060\u3051\u3067\u3001\u4E21\u5074\u304C\u7D75\u6587\u5B57\u306E\u3068\u304D\u306B\u9650\u308B\u3002
// \u7D75\u6587\u5B57\u306E\u7570\u4F53\u5B57\u30BB\u30EC\u30AF\u30BF\uFF08U+FE0F\uFF09\u306F Cf \u3067\u306F\u306A\u3044\uFF08Mn\uFF09\u306E\u3067\u3001\u3053\u3053\u3067\u306F\u6B62\u3081\u306A\u3044\u3002
const FORMAT_CHARACTER = /\p{Cf}/u;
const EMOJI_ZWJ = /(?<=\p{Extended_Pictographic}\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu;
// 対になっていないサロゲート（壊れた UTF-16）。DB へは送れない文字列である。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/**
 * Target 名に使えない、評価・おすすめ・再訪の言葉（PR #443 のレビュー対応）。
 *
 * 客が選んだ Target の名前は口コミの下書きの主題としてそのまま文に入り、下書きの事実チェック（survey-web の
 * lib/draft/structured/gate.ts）は名前を「客が選んだ語」として検査の対象から外す。名前に「絶品」「おすすめ」
 * 「また来たい」が入っていると、本人が言っていない評価・推奨・再訪の言葉が下書きに残り、店舗が口コミの内容へ
 * 介入する経路になる（CLAUDE.md「下書き文面への介入禁止」）。そこで、登録と名前の変更の時点で止める。
 *
 * 値は下書きの事実チェックの語彙（survey-web の lib/draft/structured/lexicon.json の intensity・recommendation・
 * revisit）と **同じ正規表現のソース** で、一致は survey-web のテスト（structured-target-label-rule.test.ts）が
 * 機械強制する。依存の向きは survey-web → @fwlm/db だけで、ここから survey-web を参照しない。
 *
 * 具体的な属性の語（新鮮・自家製・濃厚・出汁 など）は対象にしない。「自家製レモンサワー」「出汁巻き玉子」
 * 「濃厚担々麺」のように商品の名前そのものに入る語で、名前として登録された商品の呼び名は客の選んだ主題である。
 * 照合は NFKC へ揃えた名前に対して行う（半角カナの「ｵｽｽﾒ」も止める）。
 */
export const TARGET_LABEL_EVALUATIVE_PATTERNS: Readonly<Record<'intensity' | 'recommendation' | 'revisit', readonly string[]>> = {
  intensity: [
    'とても',
    'すごく',
    '凄く',
    '非常に',
    'かなり',
    '大変',
    'めちゃくちゃ',
    'めちゃ',
    '本当に',
    'ほんとうに',
    'ほんとに',
    '最高',
    '絶品',
    '格別',
    '抜群',
    '大満足',
    '極上',
    'とびきり',
    'この上な',
    'すこぶる',
    'ものすごく',
    'とっても',
    '絶対',
    'ぜったい',
    '圧倒的',
    'めっちゃ',
    'マジで',
  ],
  recommendation: [
    'おすすめ',
    'お勧め',
    'お薦め',
    'オススメ',
    'おススメ',
    '勧めたい',
    'すすめたい',
    'ぜひ.{0,8}(?:行って|食べて|訪れて|足を運|利用して|味わって)',
    '皆さんも',
    'みなさんも',
    '一度は',
    '行ってみて',
    '試してみて',
  ],
  revisit: ['また(?:来|行|伺|訪|利用|食べ|寄)', 'リピート', '再訪', '次回', '今度は', '次は'],
};

const EVALUATIVE_LABEL_PATTERNS: readonly RegExp[] = Object.values(TARGET_LABEL_EVALUATIVE_PATTERNS)
  .flat()
  .map((source) => new RegExp(source));

// 判定用の形で取り除く文字: 空白（White_Space・全角空白を含む）と、表示されない文字（Default_Ignorable_Code_Point・
// ゼロ幅スペース・ゼロ幅接合子・異体字セレクタ・ソフトハイフンなどを含む）。
const POLICY_REMOVED = /[\p{White_Space}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * 評価語の判定 **専用** の形（PR #443 の追加レビュー）。NFKC → 空白（White_Space）の除去 → 表示されない文字
 * （Default_Ignorable_Code_Point）の除去。「絶 品」「絶<U+200B>品」「絶<U+FE0F>品」「ｵｽｽﾒ」は、それぞれ「絶品」
 * 「オススメ」になる。
 *
 * **保存・表示には使わない。** 「焼き鳥 5種盛り」の空白は名前の一部として残す（保存する形は normalizeTargetLabel の
 * 前後の空白の除去と NFC だけ）。下書きの事実チェック（survey-web の gate.ts）も、Target 名と下書きの本文に同じ形を
 * 当てて評価・推奨・再訪の語を探す（登録の規則と実行時の検査で、すり抜けの手段を揃えて塞ぐ）。
 */
export function canonicalizeForEvaluativePolicy(text: string): string {
  return text.normalize('NFKC').replace(POLICY_REMOVED, '');
}

/** 名前が評価・おすすめ・再訪の言葉を含むか（TARGET_LABEL_EVALUATIVE_PATTERNS・canonicalizeForEvaluativePolicy の形で照合）。 */
export function hasEvaluativeTargetLabel(label: string): boolean {
  const canonical = canonicalizeForEvaluativePolicy(label);
  return EVALUATIVE_LABEL_PATTERNS.some((p) => p.test(canonical));
}

/**
 * Target 名を検証し、保存する形（前後の空白を除き、Unicode の NFC へ正規化した文字列）へ整える。
 *
 * 同名の判定は保存する形どうしで行う（見た目が同じで符号の違う 2 つの名前を、別の商品として並べない）。
 * HTML としては解釈しない。画面は React のテキストとして描くので、`<` などはそのまま文字として出る。
 */
export function normalizeTargetLabel(raw: unknown): TargetLabelResult {
  if (typeof raw !== 'string') return { ok: false, error: 'LABEL_INVALID' };
  if (LONE_SURROGATE.test(raw)) return { ok: false, error: 'LABEL_INVALID_CHARACTER' };
  const value = raw.trim().normalize('NFC');
  if (value.length === 0) return { ok: false, error: 'LABEL_EMPTY' };
  if (LINE_BREAK.test(value)) return { ok: false, error: 'LABEL_MULTILINE' };
  if (INVALID_CHARACTER.test(value)) return { ok: false, error: 'LABEL_INVALID_CHARACTER' };
  if ([...value].length > TARGET_LABEL_MAX_LENGTH) return { ok: false, error: 'LABEL_TOO_LONG' };
  if (hasEvaluativeTargetLabel(value)) return { ok: false, error: 'LABEL_EVALUATIVE' };
  // 評価語の判定を書式文字より先に行う（「絶<U+200B>品」は直し方の分かる LABEL_EVALUATIVE で返す）。
  if (FORMAT_CHARACTER.test(value.replace(EMOJI_ZWJ, ''))) return { ok: false, error: 'LABEL_INVALID_CHARACTER' };
  return { ok: true, value };
}

/** 画面とサーバーの応答に出す、Target 名の誤りの案内（何を直せばよいかを書く）。 */
export const TARGET_LABEL_ERROR_MESSAGES: Readonly<Record<TargetLabelError, string>> = {
  LABEL_INVALID: '名前を文字で入力してください。',
  LABEL_EMPTY: '名前を入力してください。',
  LABEL_TOO_LONG: `名前は${TARGET_LABEL_MAX_LENGTH}文字以内で入力してください。`,
  LABEL_MULTILINE: '名前に改行は使えません。1 行で入力してください。',
  LABEL_INVALID_CHARACTER: '名前に使えない文字が含まれています。記号や見えない文字を取り除いてください。',
  LABEL_EVALUATIVE:
    '「絶品」「おすすめ」「リピート」のような、味の評価やおすすめの言葉は名前に使えません。お客様の口コミの文にそのまま入るため、料理名・ドリンク名だけを入力してください（例：「絶品餃子」なら「餃子」）。',
};

/** active な Target の上限に達したときの案内。 */
export function targetLimitMessage(categoryLabel: string, limit: number): string {
  return `${categoryLabel}は${limit}件まで登録できます。追加するには、どれかを非表示にしてください。`;
}

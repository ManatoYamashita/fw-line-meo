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

/** 名前が評価・おすすめ・再訪の言葉を含むか（TARGET_LABEL_EVALUATIVE_PATTERNS・NFKC で照合）。 */
export function hasEvaluativeTargetLabel(label: string): boolean {
  const normalized = label.normalize('NFKC');
  return EVALUATIVE_LABEL_PATTERNS.some((p) => p.test(normalized));
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

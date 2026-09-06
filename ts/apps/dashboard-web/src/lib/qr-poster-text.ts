// 店頭掲示の文言（Issue #179・store-qr-issuance-ui Requirement 7）。
//
// **なぜ製品がこれを配るのか。** QR の飛び先は店舗ごとに一意で、そこから投稿される先はその店の
// Place に固定されている。したがって掲示文言が「星5でお願いします」であった場合、
// システム側の下書き生成がどれだけ厳格でも、掲示物 1 枚で規約違反が成立する。制裁は当該
// ビジネスプロフィールに着弾し、「このビジネスはポリシーに違反している可能性があります」の
// 公開バナーと新規クチコミの一時停止を含む。**IT に不慣れなオーナーが対象顧客である以上、
// 文言の判断を現場に委ねるのは設計上の欠陥である。**
//
// 判断の根拠は Google「マップユーザーの投稿コンテンツに関するポリシー」の原文である
// （https://support.google.com/contributionpolicy/answer/7400114 ・2026-04-17 改定で
// 「評価の操作」が新設された）。**二次情報を根拠にしない**（CLAUDE.md の制約）。
//
//   許可 … Solicit or encourage the posting of content that does represent a genuine
//          experience, without offering incentives
//          （インセンティブを提供したり、評価やクチコミの内容に影響を与えようとしたりせずに、
//            実体験に基づくコンテンツの投稿を募ったり促したりする行為）
//   禁止 … Offer incentives ... in exchange for posting any review
//          Discourage or prohibit negative reviews, or selectively solicit positive reviews
//          require or pressure users to leave ratings or write reviews while on the premises
//          特定のコンテンツを含めるよう依頼すること
//
// 分水嶺は「AI を使ったか」ではなく **「販売者が内容に影響を与えたか」** である。
// 掲示物は店内にあるので「その場での要求・強要」の条項に最も近い位置にある。**募ることは
// 許可されており、要求・強要が禁止されている**ので、文言は誘い掛けに留める。

/** 掲示物に載せる依頼文。内容を指定せず、特典を提示せず、要求の形を取らない。 */
export const POSTER_INVITATION =
  'ご来店ありがとうございました。よろしければ、ご感想をお聞かせください。';

/** 掲示物に載せる読み取りの案内。 */
export const POSTER_HOWTO = 'QR コードを読み取ると、アンケートが開きます。';

/**
 * 掲示文言に現れてはならない語。**規約の条項ごとに束ねる。**
 *
 * ここは「言い換えを網羅する辞書」ではない。網羅は不可能であり、掲示物は最終的に人が書く。
 * 目的は **代表的な違反の形を名指しして見せること**と、製品が配る文言自体がそれを含まない
 * ことを機械で固定することの 2 つである。
 */
export interface ForbiddenTermGroup {
  /** 規約上の禁止条項（原文の要旨）。 */
  readonly clause: string;
  readonly terms: readonly string[];
}

export const FORBIDDEN_TERM_GROUPS: readonly ForbiddenTermGroup[] = [
  {
    clause: '高評価だけを選んで募ること（selectively solicit positive reviews）',
    terms: ['星5', '星５', '★5', '5つ星', '五つ星', '満点', '高評価'],
  },
  {
    clause: '特定のコンテンツを含めるよう依頼すること',
    terms: ['良い口コミ', 'いい口コミ', '良い評価', 'いい評価', '褒め'],
  },
  {
    clause: 'インセンティブの提供（payment, discounts, free goods and/or services）',
    terms: ['円引き', '割引', '無料', 'プレゼント', 'クーポン', 'サービス券'],
  },
  {
    clause: '否定的クチコミの投稿を妨げること（discourage or prohibit negative reviews）',
    terms: ['投稿前にスタッフ', '投稿する前にスタッフ', '不満があれば'],
  },
];

/** 走査用に平坦化した語の一覧（順序は宣言順）。 */
export const FORBIDDEN_TERMS: readonly string[] = FORBIDDEN_TERM_GROUPS.flatMap(
  (group) => group.terms,
);

/** 文字列に含まれる禁止語を返す（1 つも無ければ空配列）。 */
export function forbiddenTermsIn(text: string): readonly string[] {
  return FORBIDDEN_TERMS.filter((term) => text.includes(term));
}

/** 掲示してはならない文言の例。**画面にだけ出し、掲示物には印刷しない。** */
export interface ProhibitedExample {
  readonly text: string;
  /** なぜ不可なのか（規約の条項に対応させる）。 */
  readonly reason: string;
}

export const PROHIBITED_EXAMPLES: readonly ProhibitedExample[] = [
  {
    text: '星5でお願いします',
    reason: '評価の内容を指定しています（高評価だけを選んで募る行為）。',
  },
  {
    text: '高評価をお願いします',
    reason: '評価の内容を指定しています（高評価だけを選んで募る行為）。',
  },
  {
    text: '良い口コミを書いてください',
    reason: '書く内容を指定しています（特定のコンテンツを含めるよう依頼する行為）。',
  },
  {
    text: '口コミ投稿で 100 円引き',
    reason: '投稿と引き換えに特典を提供しています（インセンティブの提供）。',
  },
  {
    text: 'ご不満があれば、投稿前にスタッフへお伝えください',
    reason: '否定的なクチコミの投稿を妨げています。低評価の客も同じ導線へ進めてください。',
  },
];

/** 掲示物を作るときの注意。画面にだけ出す。 */
export const POSTER_CAUTION =
  '掲示物やお声がけで投稿を求めること自体は認められています。禁じられているのは、特典と引き換えにすること、評価や書く内容を指定すること、店内で投稿を強く求めることです。';

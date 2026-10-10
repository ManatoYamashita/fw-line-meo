import type {
  StructuredMaterialCounts,
  StructuredSurveyDefinition,
  SurveyCategoryDefinition,
} from '@fwlm/db';
import type { Star } from './domain';
import { validateSurveyAnswer, type FieldError } from './validate';
import { ok, err, type Result } from './result';

// structured survey の回答契約・検証・正規化・label snapshot（Issue #436・Issue #441 の PR1）。
//
// 呼び手は /api/responses の structured の分岐（Issue #438）。表示の版・定義の指紋を照合したのと同じ定義の読み取りの
// 結果で検証・解決する。解決した素材を下書きへ渡す生成は Issue #439 で実装する（lib/draft/structured-draft.ts）。
// legacy の回答（aspectCodes / concernCodes・validate.ts）はこのファイルと独立で、意味も検証も変えない。
//
// 意味（Issue #435）:
//   { categoryCode: 'food', facetCodes: ['taste'] }                  = 料理全体 → 味
//   { categoryCode: 'food', targetId: '<uuid>', facetCodes: [] }     = 刺身盛り合わせ自体について
//   { categoryCode: 'food', targetId: '<uuid>', facetCodes: ['taste'] } = 刺身盛り合わせ → 味
// カテゴリを開いただけ（Target も facet も無い）は回答ではない。料理全体の味と刺身盛り合わせの味は
// 別の evidence で、互いへ読み替えない。同じ選択が良かったところと気になったところの両方に在って
// よい（どちらかを消したり、エラーにしたりしない）。

export type Polarity = 'positive' | 'concern';

/** 1 つのカテゴリ（と任意の Target）についての選択。targetId は Target の UUID であって名前ではない。 */
export interface SelectionGroup {
  categoryCode: string;
  targetId?: string;
  facetCodes: string[];
}

export interface StructuredSurveyAnswer {
  star: Star;
  positiveSelections: SelectionGroup[];
  concernSelections: SelectionGroup[];
  comment?: string;
}

export type SelectionField = 'positiveSelections' | 'concernSelections';

export type SelectionErrorCode =
  /** 形が不正（配列でない・文字列でない・グループ数が定義の上限を超える等）。 */
  | 'INVALID'
  /** カテゴリだけで Target も facet も無い（カテゴリを開いただけ）。 */
  | 'EMPTY_GROUP'
  /** 定義に無いカテゴリ（店舗で非表示にしたカテゴリを含む）。 */
  | 'UNKNOWN_CATEGORY'
  /** Target を持てないカテゴリに targetId が付いている。 */
  | 'TARGET_NOT_ALLOWED'
  /** 定義に無い Target（他店舗の Target・非表示にした Target を含む）。 */
  | 'UNKNOWN_TARGET'
  /** 自店の表示中の Target だが、別のカテゴリの Target である。 */
  | 'TARGET_CATEGORY_MISMATCH'
  /** そのカテゴリのどの scope にも無い facet。 */
  | 'UNKNOWN_FACET'
  /** 別の scope の facet（Target 無しに Target 用の facet・Target に Category 全体用の facet）。 */
  | 'FACET_SCOPE_MISMATCH'
  /** 同じ極性に同じカテゴリ×Target のグループが 2 つ以上ある。 */
  | 'DUPLICATE_GROUP';

export type StructuredFieldError =
  | Extract<FieldError, { field: 'star' | 'comment' }>
  | { field: SelectionField; index?: number; code: SelectionErrorCode };

interface CategoryIndex {
  definition: SurveyCategoryDefinition;
  position: number;
  categoryFacetPosition: Map<string, number>;
  targetFacetPosition: Map<string, number>;
  targetPosition: Map<string, number>;
}

interface DefinitionIndex {
  categories: Map<string, CategoryIndex>;
  /** 表示中の全 Target の id → カテゴリ code（カテゴリ違いの判定用）。 */
  targetCategory: Map<string, string>;
  /** 1 つの極性に置ける異なるグループの最大数（カテゴリごとに Category 全体 1 つ＋Target の数）。 */
  maxGroups: number;
}

function positions<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  return new Map(items.map((item, i) => [key(item), i]));
}

function indexDefinition(definition: StructuredSurveyDefinition): DefinitionIndex {
  const categories = new Map<string, CategoryIndex>();
  const targetCategory = new Map<string, string>();
  let maxGroups = 0;
  definition.categories.forEach((c, position) => {
    categories.set(c.code, {
      definition: c,
      position,
      categoryFacetPosition: positions(c.categoryFacets, (f) => f.code),
      targetFacetPosition: positions(c.targetFacets, (f) => f.code),
      targetPosition: positions(c.targets, (t) => t.id),
    });
    for (const t of c.targets) targetCategory.set(t.id, c.code);
    maxGroups += 1 + c.targets.length;
  });
  return { categories, targetCategory, maxGroups };
}

function groupKey(group: SelectionGroup): string {
  return `${group.categoryCode}\u0000${group.targetId ?? ''}`;
}

/** 1 グループを検証し、facet の重複を除いて定義の順に並べたグループを返す。 */
function validateGroup(
  raw: unknown,
  index: DefinitionIndex,
): Result<SelectionGroup, SelectionErrorCode> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return err('INVALID');
  const obj = raw as Record<string, unknown>;
  const { categoryCode, targetId, facetCodes } = obj;
  if (typeof categoryCode !== 'string') return err('INVALID');
  if (targetId !== undefined && targetId !== null && typeof targetId !== 'string') return err('INVALID');
  if (!Array.isArray(facetCodes) || !facetCodes.every((c): c is string => typeof c === 'string')) {
    return err('INVALID');
  }

  const category = index.categories.get(categoryCode);
  if (!category) return err('UNKNOWN_CATEGORY');

  const hasTarget = typeof targetId === 'string';
  if (hasTarget) {
    if (!category.definition.allowsTargets) return err('TARGET_NOT_ALLOWED');
    if (!category.targetPosition.has(targetId)) {
      return err(index.targetCategory.has(targetId) ? 'TARGET_CATEGORY_MISMATCH' : 'UNKNOWN_TARGET');
    }
  }

  // targetId の有無で許可する facet の scope が決まる。料理全体の味と Target の味は別物なので、
  // 片方の scope にしか無い facet を他方で受理しない。
  const allowed = hasTarget ? category.targetFacetPosition : category.categoryFacetPosition;
  const other = hasTarget ? category.categoryFacetPosition : category.targetFacetPosition;
  const unique = [...new Set(facetCodes)];
  for (const code of unique) {
    if (!allowed.has(code)) return err(other.has(code) ? 'FACET_SCOPE_MISMATCH' : 'UNKNOWN_FACET');
  }

  // カテゴリを開いただけ（Issue #435「Category を開くだけでは回答扱いにしない」）。Target だけの選択は
  // 「その Target 自体について」の evidence として成立する。
  if (!hasTarget && unique.length === 0) return err('EMPTY_GROUP');

  unique.sort((a, b) => (allowed.get(a) ?? 0) - (allowed.get(b) ?? 0));
  const group: SelectionGroup = { categoryCode, facetCodes: unique };
  if (hasTarget) group.targetId = targetId;
  return ok(group);
}

function validateSelections(
  raw: unknown,
  field: SelectionField,
  index: DefinitionIndex,
  errors: StructuredFieldError[],
): SelectionGroup[] {
  // 星以外は任意（Issue #435）。未指定は「選ばなかった」であって「なし」ではない。
  if (raw === undefined || raw === null) return [];
  // 異なるグループの数は定義から上限が決まる。それを超える配列は重複か不正なので、要素を見る前に拒否する。
  if (!Array.isArray(raw) || raw.length > index.maxGroups) {
    errors.push({ field, code: 'INVALID' });
    return [];
  }
  const groups: SelectionGroup[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const validated = validateGroup(item, index);
    if (!validated.ok) {
      errors.push({ field, index: i, code: validated.error });
      return;
    }
    // 同じ極性に同じカテゴリ×Target が 2 つあるときは、どちらの意味かを推測して併合しない
    // （Target だけのグループと Target＋facet のグループを併合すると「その Target 自体について」が
    // 消える）。送り手の不具合として拒否する。
    const key = groupKey(validated.value);
    if (seen.has(key)) {
      errors.push({ field, index: i, code: 'DUPLICATE_GROUP' });
      return;
    }
    seen.add(key);
    groups.push(validated.value);
  });
  return groups;
}

/** グループを定義の順（カテゴリ → Category 全体 → Target）へ並べる。極性をまたいでは触らない。 */
function sortGroups(groups: SelectionGroup[], index: DefinitionIndex): SelectionGroup[] {
  const rank = (g: SelectionGroup): [number, number] => {
    const c = index.categories.get(g.categoryCode);
    const target = g.targetId === undefined ? -1 : (c?.targetPosition.get(g.targetId) ?? 0);
    return [c?.position ?? 0, target];
  };
  return [...groups].sort((a, b) => {
    const [ca, ta] = rank(a);
    const [cb, tb] = rank(b);
    return ca - cb || ta - tb;
  });
}

/**
 * structured survey の回答を、表示した定義に照らして検証し、正規形へ揃える。
 *
 * - 星と一言は legacy と同じ規則（星必須 1〜5・一言は任意で 200 文字以内・空白だけは未回答）を、
 *   legacy と同じ実装（validateSurveyAnswer）で検査する。Issue #436「星と comment の既存制約は維持」。
 * - カテゴリ・Target・facet は定義に在るものだけを受理する。定義は店舗の表示中のカテゴリと
 *   active な Target しか持たないので、非表示のカテゴリ・非表示の Target・他店舗の Target は
 *   ここで拒否される。
 * - 正規化: グループ内の facet の重複は除き、facet・グループを定義の順へ並べる。同じ極性の同じ
 *   カテゴリ×Target のグループの重複は拒否する。
 * - 良かったところと気になったところに同じ選択が在ってもよい。片方だけ・両方空でもよい。
 *
 * エラーはフィールド単位で全件集めて返す（validate.ts と同じ方針）。
 */
export function validateStructuredAnswer(
  input: unknown,
  definition: StructuredSurveyDefinition,
): Result<StructuredSurveyAnswer, StructuredFieldError[]> {
  const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const errors: StructuredFieldError[] = [];

  // 観点の配列を渡さないので、legacy の検証が積むのは星と一言のエラーだけである。
  const base = validateSurveyAnswer({ star: obj.star, comment: obj.comment }, []);
  if (!base.ok) {
    for (const e of base.error) {
      if (e.field === 'star' || e.field === 'comment') errors.push(e);
    }
  }

  const index = indexDefinition(definition);
  const positive = validateSelections(obj.positiveSelections, 'positiveSelections', index, errors);
  const concern = validateSelections(obj.concernSelections, 'concernSelections', index, errors);

  if (errors.length > 0 || !base.ok) return err(errors);

  const answer: StructuredSurveyAnswer = {
    star: base.value.star,
    positiveSelections: sortGroups(positive, index),
    concernSelections: sortGroups(concern, index),
  };
  if (base.value.comment !== undefined) answer.comment = base.value.comment;
  return ok(answer);
}

// ---------------------------------------------------------------------------
// label snapshot（回答時点の表示名への解決）
// ---------------------------------------------------------------------------

/**
 * 極性つきの 1 つの evidence。Target の名前は **回答時点の表示名の snapshot** である。
 *
 * 回答の後に店舗が料理名を変えても、同じ回答の再生成で別の商品名にならないよう、下書きの素材
 * （sessionToken・Issue #438/Issue #439）にはこの形で持たせる。targetId は同一性の確認用に残す。
 */
export interface ResolvedSelection {
  polarity: Polarity;
  categoryCode: string;
  categoryLabel: string;
  targetId?: string;
  targetLabel?: string;
  /** 客が選んだ facet だけ。Target だけの選択では空（選ばれていない facet を推測しない）。 */
  facets: Array<{ code: string; label: string }>;
}

export interface ResolvedStructuredAnswer {
  /** 解決に使った定義の版。 */
  surveyRevision: number;
  star: Star;
  /** 良かったところ → 気になったところの順。各極性の中は定義の順。 */
  selections: ResolvedSelection[];
  comment?: string;
}

/**
 * validateStructuredAnswer が **同じ定義で** 受理した回答を、表示名の snapshot へ解決する。
 *
 * 定義に無い code / id が来たら例外にする。検証を通していない回答・別の定義で検証した回答を
 * 渡した呼び手の誤りで、名前を推測して埋めてはならない。
 */
export function resolveStructuredAnswer(
  answer: StructuredSurveyAnswer,
  definition: StructuredSurveyDefinition,
): ResolvedStructuredAnswer {
  const categories = new Map(definition.categories.map((c) => [c.code, c]));

  const resolve = (group: SelectionGroup, polarity: Polarity): ResolvedSelection => {
    const category = categories.get(group.categoryCode);
    if (!category) throw new Error(`unresolvable category: ${group.categoryCode}`);
    const facetList = group.targetId === undefined ? category.categoryFacets : category.targetFacets;
    const facets = group.facetCodes.map((code) => {
      const facet = facetList.find((f) => f.code === code);
      if (!facet) throw new Error(`unresolvable facet: ${group.categoryCode}/${code}`);
      return { code: facet.code, label: facet.label };
    });
    const resolved: ResolvedSelection = {
      polarity,
      categoryCode: category.code,
      categoryLabel: category.label,
      facets,
    };
    if (group.targetId !== undefined) {
      const target = category.targets.find((t) => t.id === group.targetId);
      if (!target) throw new Error(`unresolvable target: ${group.targetId}`);
      resolved.targetId = target.id;
      resolved.targetLabel = target.label;
    }
    return resolved;
  };

  const result: ResolvedStructuredAnswer = {
    surveyRevision: definition.revision,
    star: answer.star,
    selections: [
      ...answer.positiveSelections.map((g) => resolve(g, 'positive')),
      ...answer.concernSelections.map((g) => resolve(g, 'concern')),
    ],
  };
  if (answer.comment !== undefined) result.comment = answer.comment;
  return result;
}

// ---------------------------------------------------------------------------
// 匿名集計（素材の厚み）
// ---------------------------------------------------------------------------

/**
 * 回答を survey_structured_material_tallies の個数へ畳む（Issue #436）。
 *
 * DB へ渡るのはこの個数と一言の有無だけで、選択の中身・Target 名・一言の本文は渡らない。
 * hasComment は回答の comment から導く（下書きの素材へ渡すのと同じ値から導く・Issue #137 段階3）。
 */
export function structuredMaterialCounts(answer: StructuredSurveyAnswer): StructuredMaterialCounts {
  const count = (groups: SelectionGroup[]) => ({
    groups: groups.length,
    targets: groups.filter((g) => g.targetId !== undefined).length,
    facets: groups.reduce((n, g) => n + g.facetCodes.length, 0),
  });
  const positive = count(answer.positiveSelections);
  const concern = count(answer.concernSelections);
  return {
    positiveGroupCount: positive.groups,
    concernGroupCount: concern.groups,
    positiveTargetCount: positive.targets,
    concernTargetCount: concern.targets,
    positiveFacetCount: positive.facets,
    concernFacetCount: concern.facets,
    hasComment: answer.comment !== undefined,
  };
}

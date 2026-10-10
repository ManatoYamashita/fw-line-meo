import type { DraftMaterial } from '../../../lib/domain';
import type { DraftGenerator } from '../../../lib/draft/generator';
import { pickVariation } from '../../../lib/draft/prompt';
import type { RateLimiter } from '../../../lib/rate-limit';
import {
  surveyDefinitionFingerprint,
  type PlaceStatus,
  type StoreSurveyDefinition,
  type StructuredSurveyDefinition,
  type StructuredTallyInput,
} from '@fwlm/db';
import { checkSurveyRevision, type CurrentSurvey, type SessionTokenService } from '../../../lib/session-token';
import {
  resolveStructuredAnswer,
  structuredMaterialCounts,
  unselectedTargetsOf,
  validateStructuredAnswer,
} from '../../../lib/structured-answer';
import type { StructuredDraftPort } from '../../../lib/draft/structured-draft';
import { validateSurveyAnswer } from '../../../lib/validate';
import { jsonError, jsonOk } from '../../../lib/http';
import { REGEN_MAX } from '../../../lib/limits';
import {
  logGenerationFailure,
  logFabricationResidual,
  logFactualityResidual,
  logSurveyResponseSubmitted,
  type SurveyLogger,
} from '../../../lib/structured-log';

// 回答受付 API の中核ロジック（依存を注入してテスト可能にする）。route.ts が実依存を配線する。

export interface SurveyStoreView {
  id: string;
  name: string;
  placeId: string | null;
  placeStatus: PlaceStatus;
  /** 利用停止の時刻（Issue #252）。null なら利用中。 */
  suspendedAt: Date | null;
}

export interface AspectView {
  code: string;
  label: string;
}

export interface ResponsesDeps {
  tokens: SessionTokenService;
  generator: DraftGenerator;
  rateLimiter: RateLimiter;
  findStore: (id: string) => Promise<SurveyStoreView | null>;
  listAspects: () => Promise<AspectView[]>;
  incrementTallies: (input: {
    storeId: string;
    star: number;
    aspectCodes: string[];
    concernCodes: string[];
    hasComment: boolean;
  }) => Promise<void>;
  /**
   * 店舗の有効なアンケート定義（@fwlm/db の readStoreSurveyDefinition）。**1 回の回答につき 1 回だけ** 呼び、
   * 種類・版・指紋の照合と、structured の検証・表示名の解決に同じ結果を渡す（Issue #438）。
   */
  readDefinition: (storeId: string) => Promise<StoreSurveyDefinition>;
  /**
   * structured の回答の匿名集計（@fwlm/db の incrementStructuredTallies）。星（survey_rating_tallies）も
   * これが加算するので、structured の回答では incrementTallies を呼ばない（星を二重に数えない）。
   */
  incrementStructuredTallies: (input: StructuredTallyInput) => Promise<void>;
  /** structured の素材から下書きを作る口（Natural LLM Realizer・Issue #439）。 */
  structuredDrafts: StructuredDraftPort;
  clientKey: (req: Request) => string;
  log: SurveyLogger;
  supportCode?: string;
}

/** 表示の後にアンケートの内容が変わった（Issue #438）。通常の失敗と区別して再読み込みを案内する。 */
export const STALE_SURVEY_MESSAGE = 'アンケート内容が更新されました。ページを再読み込みして、もう一度回答してください。';

function error(deps: ResponsesDeps, status: number, code: string, message: string): Response {
  return jsonError(status, code, message, deps.supportCode);
}

export async function handleResponses(req: Request, deps: ResponsesDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(deps, 400, 'VALIDATION', '不正なリクエストです');
  }
  const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const storeId = typeof obj.storeId === 'string' ? obj.storeId : '';
  const pageToken = typeof obj.pageToken === 'string' ? obj.pageToken : '';

  // pageToken 検証（ページ経由の正規フロー証明・直接 POST を拒否）。署名・種別・店舗・期限だけを見る。
  const page = deps.tokens.verifyPage(pageToken, storeId);
  if (!page.ok) {
    return error(deps, 400, 'PAGE_TOKEN_INVALID', 'ページを再読み込みしてください');
  }

  // インスタンス内レート制限（コスト濫用の敷居上げ）
  if (!deps.rateLimiter.check(deps.clientKey(req))) {
    return error(deps, 429, 'RATE_LIMITED', '時間をおいて再度お試しください');
  }

  // 店舗（存在＋place 確定＋利用中のみ）。停止中（Issue #252）は集計にも生成にも用いない。
  const store = await deps.findStore(storeId);
  if (!store || store.placeStatus !== 'confirmed' || store.suspendedAt !== null) {
    return error(deps, 404, 'STORE_NOT_AVAILABLE', 'このアンケートは現在利用できません');
  }

  // 現在の定義を **1 回だけ** 読み、表示した画面の種類・版・定義の指紋と照合する（Issue #438）。
  // legacy の token と structured の token を互いの意味で読まない: 表示の後に店舗が structured を有効 / 無効に
  // した・設定や全店舗共通の taxonomy が変わった画面の回答は、どちらの検証へも進めずに再読み込みを案内する。
  const definition = await deps.readDefinition(storeId);
  const current: CurrentSurvey =
    definition.mode === 'legacy'
      ? { mode: 'legacy' }
      : {
          mode: 'structured',
          revision: definition.revision,
          definitionFingerprint: surveyDefinitionFingerprint(definition),
        };
  const mode = checkSurveyRevision(page.value, current);
  if (!mode.ok) {
    return error(deps, 409, 'STALE_SURVEY', STALE_SURVEY_MESSAGE);
  }
  if (mode.value === 'structured' && definition.mode === 'structured') {
    return handleStructured(body, storeId, store.name, definition, deps);
  }
  return handleLegacy(body, storeId, store, deps);
}

/**
 * structured の回答（Issue #438）。照合に使ったのと **同じ読み取りの結果** で検証し、回答時点の表示名へ解決する
 * （途中で定義を読み直さない）。集計は incrementStructuredTallies だけで、legacy の incrementTallies は呼ばない。
 * 下書きは structuredDrafts（Natural LLM Realizer・Issue #439）が作る。
 */
async function handleStructured(
  body: unknown,
  storeId: string,
  storeName: string,
  definition: StructuredSurveyDefinition,
  deps: ResponsesDeps,
): Promise<Response> {
  const validated = validateStructuredAnswer(body, definition);
  if (!validated.ok) {
    return error(deps, 400, 'VALIDATION', '入力内容をご確認ください');
  }
  const answer = validated.value;
  const material = resolveStructuredAnswer(answer, definition);

  const tally = deps
    .incrementStructuredTallies({ storeId, star: answer.star, ...structuredMaterialCounts(answer) })
    .catch(() => deps.log('warn', 'tally_failed'));
  // 未回答の Target は同じ定義から作り、事後検証だけが使う（LLM へは渡さない）。
  const structured = { storeName, ...material, unselectedTargets: unselectedTargetsOf(answer, definition) };
  const draft = deps.structuredDrafts.prepare(structured);
  const [, prepared] = await Promise.all([tally, draft]);

  // ファネルの分子（Issue #137 段階3）。legacy と同じく、客が送信した事実を記録する。
  logSurveyResponseSubmitted(deps.log, storeId);

  if (prepared.kind === 'unavailable') {
    // claim の無い回答（星だけ・一言だけ）。下書きは作らず、客の画面は回答済み（Google の投稿導線）へ進む。
    return jsonOk({ mode: 'structured', generation: 'unavailable', draft: null });
  }
  const sessionToken = deps.tokens.signStructured({ storeId, structured, attempt: 0 });
  if (prepared.kind === 'failed') {
    // 通常生成が最大回数まで作れなかった（generation error）。safe fallback の文は返さず、legacy と同じ失敗の応答に
    // する（客の画面は「下書きの生成に失敗しました」と再試行。再試行は /api/drafts が同じ素材から作る）。
    return jsonOk({ mode: 'structured', generation: 'failed', draft: null, sessionToken, regenerationsLeft: REGEN_MAX });
  }
  // 下書き（Natural LLM Realizer・Issue #439）。再生成は /api/drafts が、sessionToken に封入した同じ素材
  // （Target の名前の snapshot）から作り直す。応答の形は legacy と同じなので、下書きの画面（コピー・Google の
  // 投稿導線・再生成）をそのまま使う。
  return jsonOk({ mode: 'structured', generation: 'ok', draft: prepared.draft, sessionToken, regenerationsLeft: REGEN_MAX });
}

/** legacy の回答（従来どおり。survey_aspects の観点・incrementTallies・legacy の下書き生成）。 */
async function handleLegacy(
  body: unknown,
  storeId: string,
  store: SurveyStoreView,
  deps: ResponsesDeps,
): Promise<Response> {
  // 選択肢（seed 由来・許可 code の SoT）
  const aspects = await deps.listAspects();
  const allowed = aspects.map((a) => a.code);

  // 入力検証
  const validated = validateSurveyAnswer(body, allowed);
  if (!validated.ok) {
    return error(deps, 400, 'VALIDATION', '入力内容をご確認ください');
  }
  const { star, aspectCodes, concernCodes, comment } = validated.value;

  const labelByCode = new Map(aspects.map((a) => [a.code, a.label]));
  const aspectLabels = aspectCodes.map((c) => labelByCode.get(c) ?? c);
  const concernLabels = concernCodes.map((c) => labelByCode.get(c) ?? c);
  // 選ばれなかった観点も渡す（Issue #132）。プロンプト側が名指しで言及を禁止するのに使う。
  // 全選択のときは空配列になり、禁止句自体が出ない。
  //
  // 「選ばれた」は良かった点と気になった点の **どちらかに入っている** こと（Issue #221）。
  // 気になった点に選んだ観点を禁止句へ入れると、客が選んだ不満を下書きから消すことになる。
  const selectedCodes = new Set([...aspectCodes, ...concernCodes]);
  const unselected = aspects.filter((a) => !selectedCodes.has(a.code));
  // label はプロンプトの禁止文言に、code は生成後の事後検証に使う（Issue #132）。
  // 同じ差集合から両方を導くことで、「禁止した観点」と「検証する観点」がずれない。
  const unselectedAspectLabels = unselected.map((a) => a.label);
  const unselectedAspectCodes = unselected.map((a) => a.code);
  const material: DraftMaterial =
    comment !== undefined
      ? {
          storeName: store.name,
          star,
          aspectLabels,
          concernLabels,
          comment,
          unselectedAspectLabels,
          unselectedAspectCodes,
        }
      : {
          storeName: store.name,
          star,
          aspectLabels,
          concernLabels,
          unselectedAspectLabels,
          unselectedAspectCodes,
        };

  // 集計（非致命・失敗しても応答継続）と生成を並行実行。
  // hasComment は素材へ渡すのと **同じ値** から導く（`material` の分岐条件と同一）。別々に
  // 導くと「プロンプトが見た厚み」と「記録した厚み」がずれ、入力導線を変えた効果をこの
  // データで検証できなくなる（Issue #137 段階3）。
  const tally = deps
    .incrementTallies({ storeId, star, aspectCodes, concernCodes, hasComment: comment !== undefined })
    .catch(() => deps.log('warn', 'tally_failed'));
  const generation = deps.generator.generate(
    material,
    pickVariation(material),
    (aspectCodes) => logFactualityResidual(deps.log, aspectCodes),
    (categories) => logFabricationResidual(deps.log, categories),
  );
  const [, gen] = await Promise.all([tally, generation]);

  // ファネルの分子（Issue #137 段階3）。生成の成否や集計の成否とは独立に、「客が送信した」
  // という事実を記録する。生成失敗でも回答は届いており、表示に対する送信率の分子である。
  logSurveyResponseSubmitted(deps.log, storeId);

  // sessionToken は生成成否に関わらず必ず発行（再試行は集計非接触の /api/drafts へ）
  const sessionToken = deps.tokens.sign({ storeId, material, attempt: 0 });

  if (!gen.ok) {
    // 安全ブロックは件数把握のため INFO、その他の生成失敗は ERROR（design: Monitoring）。
    logGenerationFailure(deps.log, gen.error);
    return jsonOk({ generation: 'failed', draft: null, sessionToken, regenerationsLeft: REGEN_MAX });
  }
  return jsonOk({ generation: 'ok', draft: gen.value, sessionToken, regenerationsLeft: REGEN_MAX });
}

import type { DraftMaterial } from '../../../lib/domain';
import type { DraftGenerator } from '../../../lib/draft/generator';
import { pickVariation } from '../../../lib/draft/prompt';
import type { RateLimiter } from '../../../lib/rate-limit';
import type { PlaceStatus } from '@fwlm/db';
import type { SessionTokenService } from '../../../lib/session-token';
import { validateSurveyAnswer } from '../../../lib/validate';
import { jsonError, jsonOk } from '../../../lib/http';
import { REGEN_MAX } from '../../../lib/limits';

// 回答受付 API の中核ロジック（依存を注入してテスト可能にする）。route.ts が実依存を配線する。

export interface SurveyStoreView {
  id: string;
  name: string;
  placeId: string | null;
  placeStatus: PlaceStatus;
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
  incrementTallies: (input: { storeId: string; star: number; aspectCodes: string[] }) => Promise<void>;
  clientKey: (req: Request) => string;
  log: (level: 'warn' | 'error' | 'info', event: string) => void;
}

export async function handleResponses(req: Request, deps: ResponsesDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'VALIDATION', '不正なリクエストです');
  }
  const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const storeId = typeof obj.storeId === 'string' ? obj.storeId : '';
  const pageToken = typeof obj.pageToken === 'string' ? obj.pageToken : '';

  // pageToken 検証（ページ経由の正規フロー証明・直接 POST を拒否）
  if (!deps.tokens.verifyPage(pageToken, storeId).ok) {
    return jsonError(400, 'PAGE_TOKEN_INVALID', 'ページを再読み込みしてください');
  }

  // インスタンス内レート制限（コスト濫用の敷居上げ）
  if (!deps.rateLimiter.check(deps.clientKey(req))) {
    return jsonError(429, 'RATE_LIMITED', '時間をおいて再度お試しください');
  }

  // 店舗（存在＋place 確定のみ）
  const store = await deps.findStore(storeId);
  if (!store || store.placeStatus !== 'confirmed') {
    return jsonError(404, 'STORE_NOT_AVAILABLE', 'このアンケートは現在利用できません');
  }

  // 選択肢（seed 由来・許可 code の SoT）
  const aspects = await deps.listAspects();
  const allowed = aspects.map((a) => a.code);

  // 入力検証
  const validated = validateSurveyAnswer(body, allowed);
  if (!validated.ok) {
    return jsonError(400, 'VALIDATION', '入力内容をご確認ください');
  }
  const { star, aspectCodes, comment } = validated.value;

  const labelByCode = new Map(aspects.map((a) => [a.code, a.label]));
  const aspectLabels = aspectCodes.map((c) => labelByCode.get(c) ?? c);
  const material: DraftMaterial =
    comment !== undefined
      ? { storeName: store.name, star, aspectLabels, comment }
      : { storeName: store.name, star, aspectLabels };

  // 集計（非致命・失敗しても応答継続）と生成を並行実行
  const tally = deps
    .incrementTallies({ storeId, star, aspectCodes })
    .catch(() => deps.log('warn', 'tally_failed'));
  const generation = deps.generator.generate(material, pickVariation());
  const [, gen] = await Promise.all([tally, generation]);

  // sessionToken は生成成否に関わらず必ず発行（再試行は集計非接触の /api/drafts へ）
  const sessionToken = deps.tokens.sign({ storeId, material, attempt: 0 });

  if (!gen.ok) {
    // 安全ブロックは件数把握のため INFO、その他の生成失敗は ERROR（design: Monitoring）。
    if (gen.error.kind === 'SAFETY_BLOCKED') {
      deps.log('info', 'generation_safety_blocked');
    } else {
      deps.log('error', 'generation_failed');
    }
    return jsonOk({ generation: 'failed', draft: null, sessionToken, regenerationsLeft: REGEN_MAX });
  }
  return jsonOk({ generation: 'ok', draft: gen.value, sessionToken, regenerationsLeft: REGEN_MAX });
}

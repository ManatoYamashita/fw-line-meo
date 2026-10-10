// 店舗オーナーのアンケート設定 API の中核（Issue #437・Issue #441 の PR2）。
//
// app/api/survey-settings 配下の route.ts が実依存を配線し、ここへ委ねる（survey-web の handler.ts と同じ
// 「依存を注入してテスト可能にする」形）。
//
// 認可は詳細 API（app/api/detail/route.ts）と同じ境界をそのまま使う:
//   Authorization: Bearer {LIFF ID token} → LINE で検証した sub → owner の確定店舗の集合（認可済み集合）
//   → 集合が 1 店ならその店、複数なら `?storeId=` のヒントが集合の中で指す店（指さなければ 409 と候補）。
// **本文（JSON）の storeId は読まない。** 書き込む店舗は常に認可済み集合の中から選ばれ、他店の Target の ID を
// 渡されても DAL が「自店に無い」として 404 にする（他店に実在するかを区別して返さない）。
//
// 監査（db/write-boundary.md）: 設定の変更を確定した **後** に audit_logs へ追記する。失敗しても変更を
// 巻き戻さず、応答も変更の結果どおりに返す（警告 store-detail.audit_log_failed を残す）。料理名・ドリンク名は
// 監査記録へ写さない。

import {
  addSurveyTarget,
  readStoreSurveySettings,
  renameSurveyTarget,
  reorderSurveyTargets,
  setSurveyCategoryEnabled,
  setSurveyTargetActive,
  type AuditLogInput,
  type Queryable,
  type Result,
  type StoreRow,
  type SurveySettingsChange,
  type SurveySettingsError,
  type TransactionCapable,
} from '@fwlm/db';
import { ACTIVE_TARGET_LIMITS, TARGET_LABEL_ERROR_MESSAGES } from '@fwlm/db/survey-settings-rules';
import type { Sink } from '@fwlm/observability';

import { STORE_SELECTION_REQUIRED, type StoreRef } from './contract';
import { selectAuthorizedStore, type StoreDetailAuthorizationError } from './liff-auth';
import type { SurveySettingsResponse } from './survey-settings-contract';

export type SurveySettingsOperation =
  | { readonly kind: 'read' }
  | { readonly kind: 'addTarget' }
  | { readonly kind: 'updateTarget'; readonly targetId: string }
  | { readonly kind: 'disableTarget'; readonly targetId: string }
  | { readonly kind: 'reorderTargets' }
  | { readonly kind: 'setCategory'; readonly categoryCode: string };

export interface SurveySettingsDeps {
  /** ID トークン → 認可済み集合（lib/liff-auth.ts の authorizeStoreDetailRequest を部分適用したもの）。 */
  readonly authorize: (idToken: string) => Promise<Result<readonly StoreRow[], StoreDetailAuthorizationError>>;
  readonly pool: Queryable & TransactionCapable;
  readonly auditLog: (input: AuditLogInput) => Promise<void>;
  readonly log: Sink;
  readonly supportCode?: string;
}

// --- 応答 ---------------------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function jsonError(deps: SurveySettingsDeps, status: number, code: string, message: string): Response {
  return json(status, { error: { code, message }, ...(deps.supportCode ? { supportCode: deps.supportCode } : {}) });
}

const LIMIT_MESSAGE =
  ACTIVE_TARGET_LIMITS.food === ACTIVE_TARGET_LIMITS.drink
    ? `料理・ドリンクは、それぞれ${ACTIVE_TARGET_LIMITS.food}件まで表示できます。追加・再表示するには、どれかを非表示にしてください。`
    : `料理は${ACTIVE_TARGET_LIMITS.food}件、ドリンクは${ACTIVE_TARGET_LIMITS.drink}件まで表示できます。追加・再表示するには、どれかを非表示にしてください。`;

/** DAL の失敗 → HTTP（400 は入力の誤り・404 は自店に無い・409 は現在の設定との衝突）。 */
const ERRORS: Readonly<Record<SurveySettingsError, readonly [number, string]>> = {
  CATEGORY_NOT_EDITABLE: [400, 'このカテゴリには名前を登録できません。'],
  CATEGORY_NOT_TOGGLEABLE: [400, 'このカテゴリの表示は切り替えられません。'],
  TARGET_NOT_FOUND: [404, '項目が見つかりません。画面を開き直してください。'],
  DUPLICATE_LABEL: [409, '同じ名前がすでに表示されています。別の名前にしてください。'],
  TARGET_LIMIT_REACHED: [409, LIMIT_MESSAGE],
  INVALID_ORDER: [400, '並び順を保存できませんでした。画面を開き直してから、もう一度並べ替えてください。'],
  LABEL_INVALID: [400, TARGET_LABEL_ERROR_MESSAGES.LABEL_INVALID],
  LABEL_EMPTY: [400, TARGET_LABEL_ERROR_MESSAGES.LABEL_EMPTY],
  LABEL_TOO_LONG: [400, TARGET_LABEL_ERROR_MESSAGES.LABEL_TOO_LONG],
  LABEL_MULTILINE: [400, TARGET_LABEL_ERROR_MESSAGES.LABEL_MULTILINE],
  LABEL_INVALID_CHARACTER: [400, TARGET_LABEL_ERROR_MESSAGES.LABEL_INVALID_CHARACTER],
};

const INVALID_BODY = 'INVALID_BODY';
const INVALID_BODY_MESSAGE = '送信内容を読み取れませんでした。画面を開き直してください。';

function toStoreRefs(stores: readonly StoreRow[]): StoreRef[] {
  return stores.map((store) => ({ storeId: store.id, name: store.name }));
}

// --- 入力 ---------------------------------------------------------------------------

const BEARER_PREFIX_RE = /^Bearer\s+(.+)$/i;

function extractBearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization');
  if (!header) return null;
  const token = BEARER_PREFIX_RE.exec(header.trim())?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 本文を JSON のオブジェクトとして読む。読めなければ null。 */
async function readObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errorKindOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'UnknownError';
}

// --- 本体 ---------------------------------------------------------------------------

export async function handleSurveySettings(
  req: Request,
  operation: SurveySettingsOperation,
  deps: SurveySettingsDeps,
): Promise<Response> {
  const idToken = extractBearerToken(req);
  if (!idToken) return jsonError(deps, 401, 'UNAUTHORIZED', '認証情報が見つかりません');

  const auth = await deps.authorize(idToken);
  if (!auth.ok) {
    if (auth.error === 'INVALID_TOKEN' || auth.error === 'VERIFY_REQUEST_FAILED') {
      return jsonError(deps, 401, 'UNAUTHORIZED', '認証に失敗しました');
    }
    // OWNER_NOT_FOUND / STORE_NOT_IDENTIFIED は区別しない（詳細 API と同じ）。
    return jsonError(deps, 404, 'STORE_NOT_FOUND', '店舗情報が見つかりません');
  }
  const stores = auth.value;

  const hint = new URL(req.url).searchParams.get('storeId');
  const hinted = selectAuthorizedStore(stores, hint);
  if (hint && !hinted) {
    // 集合外のヒントは無視し、未指定と同じに扱う（値そのものは記録しない・詳細 API と同じ）。
    deps.log('warn', 'store-detail.store_hint_ignored', {
      reason: 'not_in_authorized_set',
      authorizedCount: stores.length,
    });
  }
  const store = hinted ?? (stores.length === 1 ? stores[0]! : null);
  if (store === null) {
    return json(409, {
      error: { code: STORE_SELECTION_REQUIRED, message: '設定する店舗を選んでください' },
      stores: toStoreRefs(stores),
    });
  }

  try {
    if (operation.kind !== 'read') {
      const outcome = await applyChange(req, operation, store.id, deps);
      if (outcome instanceof Response) return outcome;
      // 確定した変更ごとに監査を残す（失敗した変更は書いていないので残さない）。
      for (const change of outcome) {
        if (change.ok && change.changed) {
          await recordAudit(deps, {
            actorType: 'owner',
            actorId: store.owner_id,
            action: change.action,
            targetType: 'store',
            targetId: store.id,
          });
        }
      }
      const failed = outcome.find((change) => !change.ok);
      if (failed && !failed.ok) {
        const [status, message] = ERRORS[failed.error];
        return jsonError(deps, status, failed.error, message);
      }
    }
    const settings = await readStoreSurveySettings(deps.pool, store.id);
    const body: SurveySettingsResponse = {
      ...settings,
      storeId: store.id,
      storeName: store.name,
      stores: toStoreRefs(stores),
    };
    return json(200, body);
  } catch (err) {
    deps.log('error', 'store-detail.survey_settings_error', { errorKind: errorKindOf(err) });
    return jsonError(deps, 500, 'INTERNAL', 'サーバーエラー');
  }
}

/** 監査記録を書く。失敗は握って警告を残し、変更を巻き戻さない（dashboard-api の recordAudit と同じ規則）。 */
async function recordAudit(deps: SurveySettingsDeps, input: AuditLogInput): Promise<void> {
  try {
    await deps.auditLog(input);
  } catch (err) {
    deps.log('warn', 'store-detail.audit_log_failed', {
      errorKind: errorKindOf(err),
      auditAction: input.action,
      auditTargetId: input.targetId,
    });
  }
}

/**
 * 変更を適用し、確定した順に結果を返す（失敗した変更は最後の要素）。本文が読めないなど、DAL へ渡す前に
 * 決まる失敗は Response で返す。
 */
async function applyChange(
  req: Request,
  operation: Exclude<SurveySettingsOperation, { kind: 'read' }>,
  storeId: string,
  deps: SurveySettingsDeps,
): Promise<readonly SurveySettingsChange[] | Response> {
  const invalidBody = () => jsonError(deps, 400, INVALID_BODY, INVALID_BODY_MESSAGE);
  const notFound = () => jsonError(deps, 404, 'TARGET_NOT_FOUND', ERRORS.TARGET_NOT_FOUND[1]);

  switch (operation.kind) {
    case 'addTarget': {
      const body = await readObject(req);
      if (!body) return invalidBody();
      return [await addSurveyTarget(deps.pool, storeId, { categoryCode: body.categoryCode, label: body.label })];
    }
    case 'updateTarget': {
      // UUID の形でない ID は SQL へ渡さない（pg の 22P02 → 500 にしない）。自店に無い ID と同じ 404。
      if (!UUID_RE.test(operation.targetId)) return notFound();
      const body = await readObject(req);
      if (!body) return invalidBody();
      const { label, active } = body;
      if ((label === undefined && active === undefined) || (active !== undefined && typeof active !== 'boolean')) {
        return invalidBody();
      }
      // 名前と表示の両方が来たら、名前 → 表示の順に別々のトランザクションで確定する（それぞれ版を進める）。
      const results: SurveySettingsChange[] = [];
      if (label !== undefined) {
        const renamed = await renameSurveyTarget(deps.pool, storeId, operation.targetId, label);
        results.push(renamed);
        if (!renamed.ok) return results;
      }
      if (typeof active === 'boolean') {
        results.push(await setSurveyTargetActive(deps.pool, storeId, operation.targetId, active));
      }
      return results;
    }
    case 'disableTarget':
      if (!UUID_RE.test(operation.targetId)) return notFound();
      return [await setSurveyTargetActive(deps.pool, storeId, operation.targetId, false)];
    case 'reorderTargets': {
      const body = await readObject(req);
      if (!body) return invalidBody();
      return [
        await reorderSurveyTargets(deps.pool, storeId, { categoryCode: body.categoryCode, targetIds: body.targetIds }),
      ];
    }
    case 'setCategory': {
      const body = await readObject(req);
      if (!body || typeof body.enabled !== 'boolean') return invalidBody();
      return [await setSurveyCategoryEnabled(deps.pool, storeId, operation.categoryCode, body.enabled)];
    }
  }
}

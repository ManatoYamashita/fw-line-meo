import type { StoreCandidate } from '@fwlm/db';
import type { ConfirmOutcome, SearchOutcome } from '@fwlm/store-identification';
import { authenticate, canAccessStore, type AuthDeps } from './auth.js';
import { jsonError } from './http.js';

// POST /stores/search・POST /stores の中核ロジック（依存注入でテスト可能・ルート配線は app 側の責務）。
// 店舗登録フロー（design「店舗登録（オンボーディング代行）」）:
//   検索: 認証 → query 検証 → PlacesSearchAdapter 委譲 → found/empty/error の封筒化（3.4, 3.5, 3.6）
//   確定: 認証 → body/candidate 形状再検証 → owner 解決 → スコープ検証 → カテゴリ検証 → 登録（2.3, 2.4, 3.7–3.10）
// candidate はサーバー側に保持せず、クライアントが確定リクエストに載せて返す設計のため、
// 確定時に必ずサーバーが形状・スコープを再検証する（design のシーケンス図ノート）。
// プライバシー規律: 検索クエリ（店名）はログに出さない（line-webhook と同じ・design「Monitoring」）。

// --- POST /stores/search ---

export interface StoreSearchDeps {
  auth: AuthDeps;
  // PlacesSearchAdapter.searchCandidates（@fwlm/store-identification）委譲。
  // 最大 10 件・FieldMask・タイムアウトは adapter 側の凍結契約が強制する。
  searchCandidates: (query: string) => Promise<SearchOutcome>;
}

export interface StoreSearchRequest {
  authorization: string | undefined;
  // ルート層でパースした JSON body（形状は本ハンドラが検証する）。
  body: unknown;
}

export async function handleStoreSearch(
  deps: StoreSearchDeps,
  req: StoreSearchRequest,
): Promise<Response> {
  // 1. 認証（Bearer 検証 → 利用者解決）。design のコード体系（小文字）に従う。
  const auth = await authenticate(deps.auth, req.authorization);
  if (auth.kind === 'unauthenticated') {
    return jsonError(401, 'unauthenticated', 'ログインが必要です');
  }
  if (auth.kind === 'unregistered' || auth.kind === 'disabled') {
    // 未登録・無効化はいずれもアクセス権なし（403）。存在有無を漏らさない同一封筒。
    return jsonError(403, 'forbidden', 'アクセス権がありません');
  }

  // 2. query 検証（トリム後に非空の文字列のみ許可）。不正なら外部 API を呼ばない。
  const query = parseQuery(req.body);
  if (query === null) {
    return jsonError(400, 'validation_failed', '店名を入力してください');
  }

  // 3. 検索委譲。empty（0件）は 200 + 空配列（UI が 3.5 の再検索案内を出す）。error のみ 502。
  const outcome = await deps.searchCandidates(query);
  switch (outcome.kind) {
    case 'found':
      return jsonOk(200, { candidates: outcome.candidates });
    case 'empty':
      return jsonOk(200, { candidates: [] });
    case 'error':
      return jsonError(
        502,
        'places_error',
        '店舗候補の検索に失敗しました。時間をおいて再試行してください',
      );
  }
}

// --- POST /stores ---

// ダッシュボード登録専用の登録依存契約。共有 StoreIdentificationService.confirmStore は
// categoryCode を受けない（凍結契約）ため、配線側（タスク 3.1）が共有サービスの TX 意味論を
// 保ったまま categoryCode 設定を合成した実装を注入する。
export interface RegisterStoreInput {
  ownerId: string;
  candidate: StoreCandidate;
  categoryCode: string | null; // null = 未指定（categories は seed が単一情報源）
}

export interface StoreRegistrationDeps {
  auth: AuthDeps;
  // findOwnerWithAgency（@fwlm/db）委譲。DAL は UUID ガードを持たないため、
  // 呼び出し前に本ハンドラが UUID 形式を事前検証する（tasks.md 1.3 の注意書き）。
  findOwner: (ownerId: string) => Promise<{ id: string; agencyId: string } | null>;
  // categoryCode が categories（seed）に存在するコードかの検証。
  isValidCategory: (code: string) => Promise<boolean>;
  // 確定登録（confirmed 登録＋owner の store_identified 遷移＋categoryCode 設定）。
  registerStore: (input: RegisterStoreInput) => Promise<ConfirmOutcome>;
}

export interface StoreRegisterRequest {
  authorization: string | undefined;
  // ルート層でパースした JSON body（形状は本ハンドラが検証する）。
  body: unknown;
}

// UUID 形式でない ownerId は DB を叩かず 404 扱い（存在の探り当てを許さない・qr 経路と同じ規律）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleStoreRegister(
  deps: StoreRegistrationDeps,
  req: StoreRegisterRequest,
): Promise<Response> {
  // 1. 認証（Bearer 検証 → 利用者解決）。
  const auth = await authenticate(deps.auth, req.authorization);
  if (auth.kind === 'unauthenticated') {
    return jsonError(401, 'unauthenticated', 'ログインが必要です');
  }
  if (auth.kind === 'unregistered' || auth.kind === 'disabled') {
    return jsonError(403, 'forbidden', 'アクセス権がありません');
  }

  // 2. body 形状検証（ownerId / candidate / categoryCode）。クライアント保持の candidate を
  //    サーバー側で再検証する（design のシーケンス図ノート・2.4）。
  const input = parseRegisterBody(req.body);
  if (input === null) {
    return jsonError(400, 'validation_failed', '入力内容が正しくありません');
  }

  // 3. UUID 事前ガード（DAL に到達させない）→ owner 解決。不在・不正はいずれも 404（存在の秘匿）。
  if (!UUID_RE.test(input.ownerId)) {
    return jsonError(404, 'not_found', 'オーナーが見つかりません');
  }
  const ownerRef = await deps.findOwner(input.ownerId);
  if (ownerRef === null) {
    return jsonError(404, 'not_found', 'オーナーが見つかりません');
  }

  // 4. スコープ検証: オーナーの所属代理店が利用者の許可範囲内か（operator=任意 / agency=自代理店のみ）。
  //    拒否時は registerStore を一切呼ばない（担当外への紐付けを構造的に作らない・2.3, 2.4）。
  if (!canAccessStore(auth.user, ownerRef.agencyId)) {
    return jsonError(403, 'forbidden', 'このオーナーへのアクセス権がありません');
  }

  // 5. カテゴリ検証（指定時のみ）。categories（seed）に存在するコードだけを許す。
  if (input.categoryCode !== null) {
    const valid = await deps.isValidCategory(input.categoryCode);
    if (!valid) {
      return jsonError(400, 'validation_failed', '選択されたカテゴリが正しくありません');
    }
  }

  // 6. 確定登録。登録済み Place（他店舗として登録済み）は 409 に写像する（3.9）。
  const outcome = await deps.registerStore(input);
  switch (outcome.kind) {
    case 'confirmed':
      return jsonOk(201, { storeId: outcome.storeId });
    case 'place_already_registered':
      return jsonError(
        409,
        'place_already_registered',
        'この店舗（Place）は既に登録されています',
      );
  }
}

// --- 入力検証（クライアント由来の unknown を狭める。any は使わない）---

function parseQuery(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const { query } = body;
  if (typeof query !== 'string') return null;
  const trimmed = query.trim();
  return trimmed === '' ? null : trimmed;
}

function parseRegisterBody(body: unknown): RegisterStoreInput | null {
  if (!isRecord(body)) return null;
  const { ownerId, candidate, categoryCode } = body;
  if (typeof ownerId !== 'string' || ownerId === '') return null;
  const parsedCandidate = parseCandidate(candidate);
  if (parsedCandidate === null) return null;
  // categoryCode は未指定（undefined/null）または非空文字列のみ許可。
  if (categoryCode !== undefined && categoryCode !== null && typeof categoryCode !== 'string') {
    return null;
  }
  const normalizedCategory = typeof categoryCode === 'string' ? categoryCode.trim() : null;
  if (normalizedCategory === '') return null;
  return { ownerId, candidate: parsedCandidate, categoryCode: normalizedCategory };
}

// StoreCandidate の形状再検証。検証済みフィールドのみで再構成し、余分なフィールドは通さない。
function parseCandidate(value: unknown): StoreCandidate | null {
  if (!isRecord(value)) return null;
  const { placeId, name, address, latitude, longitude, types } = value;
  if (typeof placeId !== 'string' || placeId === '') return null;
  if (typeof name !== 'string' || name === '') return null;
  if (typeof address !== 'string') return null;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude)) return null;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude)) return null;
  if (!Array.isArray(types)) return null;
  const parsedTypes: string[] = [];
  for (const t of types) {
    if (typeof t !== 'string') return null;
    parsedTypes.push(t);
  }
  return { placeId, name, address, latitude, longitude, types: parsedTypes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonOk(status: 200 | 201, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

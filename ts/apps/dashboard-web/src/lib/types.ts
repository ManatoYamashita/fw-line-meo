// dashboard-api（Hono）が返す一覧・候補・カテゴリの型。dashboard-web は @fwlm/db に依存しないため
// 契約に一致する形で再定義する（api.ts の DashboardRole/Me と同じ方針）。
// createdAt は HTTP(JSON) を跨ぐため文字列（ISO8601）で受ける。
// 出典: design「dashboard-api の API 契約表」「@fwlm/db 追加アクセサ」（StoreListItem / OwnerListItem 等）。

// 店舗特定の状態（four-tier-data-model の PlaceStatus と同値）。
export type PlaceStatus = 'pending' | 'confirmed';

// オーナーのオンボーディング状態（four-tier-data-model の OnboardingStatus と同値）。
export type OnboardingStatus = 'pending' | 'store_identified' | 'active';

// GET /stores の 1 行（design: listStoresWithStatus の返却型）。
export interface StoreListItem {
  id: string;
  name: string;
  placeStatus: PlaceStatus;
  competitorConfigured: boolean; // 競合が設定済みか（EXISTS competitors WHERE active）
  ownerId: string;
  ownerDisplayName: string | null;
  agencyId: string;
  agencyName: string;
  createdAt: string;
}

// GET /owners の 1 件（登録対象オーナー選択用）。
export interface OwnerListItem {
  id: string;
  displayName: string | null;
  onboardingStatus: OnboardingStatus;
  createdAt: string;
}

// GET /agencies の 1 件（operator 専用）。
export interface AgencyItem {
  id: string;
  operatorId: string;
  name: string;
  createdAt: string;
}

// POST /stores/search の候補（@fwlm/db StoreCandidate と同一契約）。
// サーバー側には保持されず、確定リクエストにクライアントがそのまま載せて返す（design のシーケンス注記）。
export interface StoreCandidate {
  placeId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  types: readonly string[];
}

// GET /categories の 1 件（seed が単一情報源）。
export interface Category {
  code: string;
  label: string;
}

// GET /invite-codes の 1 件（@fwlm/db InviteCodeItem と同一契約。design: invite-codes.ts）。
// disabled=true は無効化済み（以後のオーナー紐付けに使えない。Req 5.1/5.3）。
export interface InviteCodeItem {
  id: string;
  agencyId: string;
  code: string;
  disabled: boolean;
  createdAt: string;
}

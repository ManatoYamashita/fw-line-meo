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
  // 停止時刻（ISO 8601）。null は利用中、値ありは停止中（store-suspension design「StoreSuspensionControl」）。
  suspendedAt: string | null;
}

// POST /stores/:id/suspend・/resume の 200 応答内 store（store-suspension tasks 5.2）。
export interface StoreSuspensionState {
  id: string;
  suspendedAt: string | null;
}

// オーナーの登録に用いられた招待コード（agency-dashboard Req 8.5）。disabled は登録後に無効化されたか。
export interface OwnerInviteCodeRecord {
  id: string;
  code: string;
  disabled: boolean;
}

// オーナーと LINE の連携状態（owner-line-unlink Req 2.1）。LINE ユーザー ID そのものは応答に含まれない。
export type OwnerLineLink = 'linked' | 'unlinked';

// GET /owners の 1 件（店舗登録のオーナー選択と、オーナー一覧の画面が使う）。
// 契約の正典は dashboard-api の owners-list.ts（OwnerListItemJson）。
export interface OwnerListItem {
  id: string;
  displayName: string | null;
  onboardingStatus: OnboardingStatus;
  createdAt: string;
  /** null = 記録なし（招待コードを記録し始める前の登録）。推定で埋めない（Req 8.4）。 */
  inviteCode: OwnerInviteCodeRecord | null;
  // 担当代理店の名前（運営が全代理店のオーナーを見るときに区別する・owner-line-unlink Req 2.1）。
  agencyName: string;
  // LINE との連携状態（owner-line-unlink Req 2.1, 2.5）。
  lineLink: OwnerLineLink;
  // 解除した元の LINE アカウントから完了後メニューをまだ外せていない（owner-line-unlink Req 3.2, 3.3）。
  menuUnlinkPending: boolean;
  // 確定済み店舗の名前（作成順）。
  storeNames: string[];
  // 店舗を引き継いだオーナー（owner-line-unlink Req 2.6）。引継ぎが無ければ null。
  takenOverBy: { ownerId: string; displayName: string | null } | null;
}

// POST /owners/:id/unlink のメニューの結果（owner-line-unlink Req 3.1, 3.2）。
// removed = 外した、failed = 外せなかった（解除は確定済み）、not_needed = 外す対象が無かった。
export type MenuUnlinkResult = 'removed' | 'failed' | 'not_needed';

// POST /owners/:id/unlink の 200 応答（契約の正典は dashboard-api の owner-line-unlink.ts）。
// menu が failed のときだけ menuUnlinkPending が true になり、画面は「メニューを外し直す」を出す。
export interface OwnerLineUnlinkResult {
  owner: { id: string; lineLink: 'unlinked'; menuUnlinkPending: boolean };
  menu: MenuUnlinkResult;
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

// POST /stores/search の候補 1 件を画面側で持つ形（Issue #485）。
// 応答の `alreadyRegistered` は「検索の注釈」であり、確定に送る候補（StoreCandidate）とは分けて持つ。
// 型の上で混ぜると、注釈を確定の要求へ載せる経路が生まれる（サーバーは捨てるが、契約として混ぜない）。
export interface StoreSearchResult {
  candidate: StoreCandidate;
  // stores.place_id に同じ値があれば true（停止中の店舗も含む）。どの代理店の店舗かは返らない。
  alreadyRegistered: boolean;
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

// GET /dashboard-users の 1 件（design: dashboard-api DashboardUserItemJson・operator 専用）。
// role='agency' は agencyId 非 null、role='operator' は agencyId=null（ck_dashboard_role_scope に対応・Req 6.3）。
// disabled=true は無効化済み（以後のログイン不可・Req 6.4）。email/displayName は保留行では null になり得る。
export interface DashboardUserItem {
  id: string;
  role: 'operator' | 'agency';
  operatorId: string;
  agencyId: string | null;
  email: string | null;
  displayName: string | null;
  disabled: boolean;
  createdAt: string;
}

import { serve } from '@hono/node-server';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import QRCode from 'qrcode';
import {
  getPool,
  findByAuthSubject,
  findStoreWithAgency,
  linkAuthSubjectByEmail,
  listStoresWithStatus,
  setStoreCategory,
  findAgencyName,
  findDashboardUserDisplayName,
  listOwnersByAgency,
  findOwnerWithAgency,
  listCategories,
  listAgencies,
  createAgency,
  listInviteCodes,
  createInviteCode,
  disableInviteCode,
  listDashboardUsers,
  createPendingDashboardUser,
  disableDashboardUserGuarded,
  enableDashboardUser,
} from '@fwlm/db';
import {
  createPlacesSearchAdapter,
  createStoreIdentificationService,
  type ConfirmOutcome,
} from '@fwlm/store-identification';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import type { AuthDeps } from './auth.js';
import { createUniqueInviteCode, generateInviteCode } from './invite-code-gen.js';
import type { RegisterStoreInput } from './store-registration.js';

// Cloud Run エントリ。必須 env を検証し、firebase-admin / DB / Places / qrcode の実依存を配線する。
const config = loadConfig();

// 添付 SA の ADC を使用（Cloud Run）。
initializeApp();
const firebaseAuth = getAuth();

// 認証依存（全業務ハンドラと qr 経路で共有）。
// firebase-admin の DecodedIdToken を VerifiedToken へ写像する（検証済みクレームのみ使う）。
// 認可の真実は Postgres（dashboard_users）にのみ置く（Firebase カスタムクレームは使わない）。
const authDeps: AuthDeps = {
  verifier: {
    verifyIdToken: async (token) => {
      const decoded = await firebaseAuth.verifyIdToken(token);
      return {
        uid: decoded.uid,
        email: decoded.email ?? null,
        emailVerified: decoded.email_verified ?? false,
        signInProvider: decoded.firebase.sign_in_provider ?? null,
      };
    },
  },
  findUser: async (uid) => findByAuthSubject(await getPool(), uid),
  linkByEmail: async (email, uid) => linkAuthSubjectByEmail(await getPool(), email, uid),
};

// Places 検索アダプタ（Node ネイティブ fetch）と店舗特定サービス（confirmStore の凍結 TX 契約）。
// ConnectablePool は getPool() の遅延解決で満たす（pg Pool.connect() が TransactionClient を返す）。
const places = createPlacesSearchAdapter({ apiKey: config.placesApiKey, fetch });
const storeIdentification = createStoreIdentificationService({
  pool: { connect: async () => (await getPool()).connect() },
  places,
});

// registerStore 合成（2.3 handoff）: 凍結契約 confirmStore（stores INSERT confirmed →
// owner store_identified の単一 TX・ux_stores_place_id 違反の冪等/409 正規化）はそのまま再利用し、
// confirmed かつ categoryCode 指定時のみ非クリティカルな category を後追いで設定する
// （category はメタデータで Go バッチ側にフォールバックがあるため、設定失敗は登録全体を失敗させない）。
async function registerStore(input: RegisterStoreInput): Promise<ConfirmOutcome> {
  const outcome = await storeIdentification.confirmStore(input.ownerId, input.candidate);
  if (outcome.kind === 'confirmed' && input.categoryCode !== null) {
    try {
      await setStoreCategory(await getPool(), outcome.storeId, input.categoryCode);
    } catch {
      // category 設定は非クリティカル（登録本体は既に成立済み）。PII・クエリは出さない。
      console.error('registerStore: category follow-up update failed', {
        storeId: outcome.storeId,
      });
    }
  }
  return outcome;
}

// issueCode 合成（2.4 handoff）: 一意コード発行（衝突は最大 3 回再生成）。
// リトライ切れ・DB 障害はここでログ出力（PII・クエリは出さない）してから rethrow し、
// ハンドラが 500 internal に写像する（design Monitoring「5xx 詳細はログへ」）。
async function issueCode(agencyId: string) {
  try {
    return await createUniqueInviteCode({
      generate: generateInviteCode,
      create: async (code) => createInviteCode(await getPool(), { agencyId, code }),
    });
  } catch (err) {
    console.error('issueCode: failed to issue invite code (retry exhausted or db error)');
    throw err;
  }
}

const app = createApp({
  corsOrigin: config.corsOrigin,
  qr: {
    auth: authDeps,
    findStore: async (id) => findStoreWithAgency(await getPool(), id),
    renderQr: (text, size) => QRCode.toBuffer(text, { width: size, margin: 1 }),
    surveyBaseUrl: config.surveyBaseUrl,
  },
  me: {
    auth: authDeps,
    findAgencyName: async (agencyId) => findAgencyName(await getPool(), agencyId),
    findDisplayName: async (userId) => findDashboardUserDisplayName(await getPool(), userId),
  },
  stores: {
    auth: authDeps,
    listStores: async (filter) => listStoresWithStatus(await getPool(), filter),
  },
  owners: {
    auth: authDeps,
    listOwners: async (agencyId) => listOwnersByAgency(await getPool(), agencyId),
  },
  categories: {
    auth: authDeps,
    listCategories: async () => listCategories(await getPool()),
  },
  storeRegistration: {
    search: {
      auth: authDeps,
      searchCandidates: (query) => storeIdentification.searchCandidates(query),
    },
    register: {
      auth: authDeps,
      findOwner: async (ownerId) => findOwnerWithAgency(await getPool(), ownerId),
      isValidCategory: async (code) =>
        (await listCategories(await getPool())).some((cat) => cat.code === code),
      registerStore,
    },
  },
  inviteCodes: {
    list: {
      auth: authDeps,
      listInviteCodes: async (agencyId) => listInviteCodes(await getPool(), agencyId),
    },
    issue: {
      auth: authDeps,
      issueCode,
    },
    disable: {
      auth: authDeps,
      disableCode: async (id, agencyId) => disableInviteCode(await getPool(), id, agencyId),
    },
  },
  admin: {
    agenciesList: {
      auth: authDeps,
      listAgencies: async (operatorId) => listAgencies(await getPool(), operatorId),
    },
    agencyCreate: {
      auth: authDeps,
      createAgency: async (input) => createAgency(await getPool(), input),
    },
    usersList: {
      auth: authDeps,
      listUsers: async (operatorId) => listDashboardUsers(await getPool(), operatorId),
    },
    userCreate: {
      auth: authDeps,
      createUser: async (input) => createPendingDashboardUser(await getPool(), input),
    },
    userDisable: {
      auth: authDeps,
      // 保護付き無効化（自己無効化拒否はハンドラ側・最後の運営保護と並行直列化は DAL 側）。
      // getPool() の戻り値 Pool は TransactionCapable（connect を持つ）に構造適合する。
      disableUser: async (id, operatorId) =>
        disableDashboardUserGuarded(await getPool(), id, operatorId),
    },
    userEnable: {
      auth: authDeps,
      // 再有効化（disabled_at を NULL に戻す・operator_id スコープ）。不在・越権は null → 404。
      enableUser: async (id, operatorId) => enableDashboardUser(await getPool(), id, operatorId),
    },
  },
});

serve({ fetch: app.fetch, port: config.port });

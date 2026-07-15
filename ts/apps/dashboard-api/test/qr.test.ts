import { describe, it, expect, vi } from 'vitest';
import QRCode from 'qrcode';
import { handleQr, type QrDeps } from '../src/qr.js';
import type { StoreWithAgency, DashboardUserIdentity } from '@fwlm/db';

const STORE = '44444444-4444-4444-4444-444444444444';
const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG_OWN: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };
const AG_OTHER: DashboardUserIdentity = { id: 'u3', role: 'agency', operatorId: 'op1', agencyId: 'ag2' };

function store(over: Partial<StoreWithAgency> = {}): StoreWithAgency {
  return {
    id: STORE,
    name: 'テスト店',
    placeId: 'ChIJ',
    placeStatus: 'confirmed',
    ownerId: 'ow1',
    agencyId: 'ag1',
    ...over,
  };
}

function deps(over: Partial<QrDeps> = {}, user: DashboardUserIdentity | null = OP): QrDeps {
  return {
    auth: {
      verifier: {
        verifyIdToken: (t) =>
          Promise.resolve({ uid: `uid-${t}`, email: null, emailVerified: false, signInProvider: null }),
      },
      findUser: () => Promise.resolve(user === null ? null : { ...user, disabled: false }),
      linkByEmail: () => Promise.resolve(null),
    },
    findStore: () => Promise.resolve(store()),
    renderQr: () => Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    surveyBaseUrl: 'https://survey.example',
    ...over,
  };
}

function req(over: Partial<{ storeId: string; size: number; authorization: string }> = {}) {
  return { storeId: STORE, size: 512, authorization: 'Bearer tok', ...over };
}

describe('handleQr', () => {
  it('認証なしは 401', async () => {
    const res = await handleQr(deps(), req({ authorization: undefined }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHENTICATED');
  });

  it('未登録 UID は 403', async () => {
    const res = await handleQr(deps({}, null), req());
    expect(res.status).toBe(403);
  });

  it('無効化済みユーザーは 403（disabled → 403 写像・未登録と同一メッセージ）', async () => {
    const d = deps();
    d.auth.findUser = () => Promise.resolve({ ...AG_OWN, disabled: true });
    const res = await handleQr(d, req());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('店舗不在は 404', async () => {
    const res = await handleQr(deps({ findStore: () => Promise.resolve(null) }), req());
    expect(res.status).toBe(404);
  });

  it('agency 他店は 403（RBAC）', async () => {
    const res = await handleQr(deps({}, AG_OTHER), req());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('place 未確定は 409', async () => {
    const res = await handleQr(
      deps({ findStore: () => Promise.resolve(store({ placeStatus: 'pending', placeId: null })) }),
      req(),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('PLACE_NOT_CONFIRMED');
  });

  it('agency 他店は place 未確定でも 403（RBAC が 409 より先・情報漏洩防止）', async () => {
    const res = await handleQr(
      deps({ findStore: () => Promise.resolve(store({ placeStatus: 'pending', placeId: null })) }, AG_OTHER),
      req(),
    );
    expect(res.status).toBe(403); // 409 ではない
  });

  it('operator は確定店舗の QR を 200 image/png で返す', async () => {
    const renderQr = vi.fn(() => Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    const res = await handleQr(deps({ renderQr }), req());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="qr-${STORE}.png"`);
    // QR の中身は {SURVEY_BASE_URL}/s/{storeId}
    expect(renderQr).toHaveBeenCalledWith(`https://survey.example/s/${STORE}`, 512);
  });

  it('agency 担当店は 200', async () => {
    const res = await handleQr(deps({}, AG_OWN), req());
    expect(res.status).toBe(200);
  });

  it('実 qrcode で有効な PNG（マジックバイト）を返す', async () => {
    const renderQr = (text: string, size: number) => QRCode.toBuffer(text, { width: size });
    const res = await handleQr(deps({ renderQr }), req());
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG シグネチャ: 89 50 4E 47 0D 0A 1A 0A
    expect(buf.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(buf.length).toBeGreaterThan(100);
  });
});

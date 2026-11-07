import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import {
  appendCrosspostMaterial,
  approveCrosspostDraft,
  attachCrosspostMedia,
  beginCrosspostReview,
  claimCrosspostDelivery,
  closeCrosspostDraft,
  createCrosspostDraft,
  getCrosspostDelivery,
  getCrosspostDraft,
  getCrosspostMedia,
  getOpenCrosspostDraft,
  listCrosspostDeliveries,
  listCrosspostEligibleStores,
  listRecentCrosspostPosts,
  markStaleCrosspostDeliveries,
  purgeExpiredCrosspostDrafts,
  recordCrosspostOutcome,
  releaseSettledCrosspostMedia,
  resolveUnknownCrosspostDelivery,
  saveCrosspostCheckpoint,
  saveCrosspostTexts,
  setCrosspostInputMode,
  type CrosspostDraftRow,
  type CrosspostMediaInput,
} from '../src/crosspost.js';
import type { Result } from '../src/types.js';

// 専用 UUID プレフィックス `3c`（ワークスペースの *.db.test.ts で未使用であること）。
const OP = '3c000000-0000-0000-0000-000000000001';
const AG = '3c000000-0000-0000-0000-000000000002';
const OWNER_A = '3ca00000-0000-0000-0000-00000000000a';
const OWNER_B = '3cb00000-0000-0000-0000-00000000000b';
const STORE_A1 = '3ca50000-0000-0000-0000-000000000001';
const STORE_A2 = '3ca50000-0000-0000-0000-000000000002';
const STORE_A_SUSPENDED = '3ca50000-0000-0000-0000-000000000003';
const STORE_A_UNCONFIRMED = '3ca50000-0000-0000-0000-000000000004';
const STORE_B1 = '3cb50000-0000-0000-0000-000000000001';
const ALLOWED = [STORE_A1, STORE_A2, STORE_A_SUSPENDED, STORE_A_UNCONFIRMED, STORE_B1];
const MAX_ATTEMPTS = 3;

function unwrap<T, E>(res: Result<T, E>): T {
  if (!res.ok) throw new Error(`expected ok Result, got error: ${String(res.error)}`);
  return res.value;
}

const later = (): Date => new Date(Date.now() + 24 * 3600 * 1000);
const purgeLater = (): Date => new Date(Date.now() + 30 * 24 * 3600 * 1000);

let mediaSeq = 0;
function mediaInput(lineMessageId: string): CrosspostMediaInput {
  mediaSeq += 1;
  return {
    lineMessageId,
    storageKey: `crosspost/3c-${mediaSeq}-${lineMessageId}.jpg`,
    contentType: 'image/jpeg',
    width: 1080,
    height: 1080,
    byteSize: 123_456,
    sha256: 'a'.repeat(64),
  };
}

async function resetCrosspost(): Promise<void> {
  const pool = await getPool();
  await pool.query('DELETE FROM crosspost_drafts WHERE owner_id = ANY($1::uuid[])', [[OWNER_A, OWNER_B]]);
}

async function newReviewingDraft(
  ownerId = OWNER_A,
  storeId = STORE_A1,
  texts: { instagram?: string; google?: string } = { instagram: 'IG本文', google: 'Google本文' },
): Promise<CrosspostDraftRow> {
  const pool = await getPool();
  const draft = unwrap(
    await createCrosspostDraft(pool, {
      ownerId,
      storeId,
      allowedStoreIds: ALLOWED,
      expiresAt: later(),
      purgeAfter: purgeLater(),
    }),
  );
  unwrap(await appendCrosspostMaterial(pool, { ownerId, draftId: draft.id, text: '新メニューの告知', expiresAt: later() }));
  const reviewing = await beginCrosspostReview(pool, { ownerId, draftId: draft.id, expiresAt: later() });
  if (!reviewing) throw new Error('beginCrosspostReview failed');
  const saved = await saveCrosspostTexts(pool, {
    ownerId,
    draftId: draft.id,
    expectedRevision: reviewing.revision,
    texts,
    expiresAt: later(),
  });
  if (!saved) throw new Error('saveCrosspostTexts failed');
  return saved;
}

describe.skipIf(!process.env.DATABASE_URL)('crosspost accessors (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'crosspost運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, 'crosspost代理店']);
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
       VALUES ($1, $3, 'U-3c-owner-a', 'store_identified'), ($2, $3, 'U-3c-owner-b', 'store_identified')`,
      [OWNER_A, OWNER_B, AG],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status, suspended_at, created_at)
       VALUES ($1, $6, 'A店1', 'ChIJ_3c_a1', 'confirmed', NULL, now() - interval '3 day'),
              ($2, $6, 'A店2', 'ChIJ_3c_a2', 'confirmed', NULL, now() - interval '2 day'),
              ($3, $6, 'A停止店', 'ChIJ_3c_a3', 'confirmed', now(), now() - interval '1 day'),
              ($4, $6, 'A未確定店', NULL, 'pending', NULL, now()),
              ($5, $7, 'B店1', 'ChIJ_3c_b1', 'confirmed', NULL, now())`,
      [STORE_A1, STORE_A2, STORE_A_SUSPENDED, STORE_A_UNCONFIRMED, STORE_B1, OWNER_A, OWNER_B],
    );
  });

  beforeEach(async () => {
    await resetCrosspost();
  });

  afterAll(async () => {
    await resetCrosspost();
    await closePool();
  });

  describe('listCrosspostEligibleStores', () => {
    it('所有・確定・利用中・有効化の指定に含まれる店舗だけを作成順に返す', async () => {
      const pool = await getPool();
      const stores = await listCrosspostEligibleStores(pool, OWNER_A, ALLOWED);
      expect(stores.map((s) => s.id)).toEqual([STORE_A1, STORE_A2]);
    });

    it('有効化の指定が空なら 0 件（既定 OFF）', async () => {
      const pool = await getPool();
      expect(await listCrosspostEligibleStores(pool, OWNER_A, [])).toEqual([]);
    });

    it('指定に含まれない店舗は返さない', async () => {
      const pool = await getPool();
      const stores = await listCrosspostEligibleStores(pool, OWNER_A, [STORE_A2]);
      expect(stores.map((s) => s.id)).toEqual([STORE_A2]);
    });
  });

  describe('下書きの作成と受け取り', () => {
    it('他のオーナーの店舗・停止中・未確定・指定外の店舗では作らない', async () => {
      const pool = await getPool();
      const base = { ownerId: OWNER_A, allowedStoreIds: ALLOWED, expiresAt: later(), purgeAfter: purgeLater() };
      for (const storeId of [STORE_B1, STORE_A_SUSPENDED, STORE_A_UNCONFIRMED]) {
        expect(await createCrosspostDraft(pool, { ...base, storeId })).toEqual({ ok: false, error: 'STORE_NOT_ELIGIBLE' });
      }
      expect(
        await createCrosspostDraft(pool, { ...base, storeId: STORE_A1, allowedStoreIds: [STORE_A2] }),
      ).toEqual({ ok: false, error: 'STORE_NOT_ELIGIBLE' });
    });

    it('作成中の下書きは owner あたり 1 つ。2 つ目は OPEN_DRAFT_EXISTS（黙って置き換えない）', async () => {
      const pool = await getPool();
      const base = { ownerId: OWNER_A, allowedStoreIds: ALLOWED, expiresAt: later(), purgeAfter: purgeLater() };
      const first = unwrap(await createCrosspostDraft(pool, { ...base, storeId: STORE_A1 }));
      expect(await createCrosspostDraft(pool, { ...base, storeId: STORE_A2 })).toEqual({
        ok: false,
        error: 'OPEN_DRAFT_EXISTS',
      });
      const open = await getOpenCrosspostDraft(pool, OWNER_A);
      expect(open?.draft.id).toBe(first.id);
      expect(open?.storeName).toBe('A店1');
      expect(open?.serviceable).toBe(true);
      // 他のオーナーからは見えない
      expect(await getOpenCrosspostDraft(pool, OWNER_B)).toBeNull();
    });

    it('素材は受け取った順に改行でつなぐ。2,000 字を超える追記は TOO_LONG で何も変えない', async () => {
      const pool = await getPool();
      const draft = unwrap(
        await createCrosspostDraft(pool, {
          ownerId: OWNER_A,
          storeId: STORE_A1,
          allowedStoreIds: ALLOWED,
          expiresAt: later(),
          purgeAfter: purgeLater(),
        }),
      );
      unwrap(await appendCrosspostMaterial(pool, { ownerId: OWNER_A, draftId: draft.id, text: '一通目', expiresAt: later() }));
      const second = unwrap(
        await appendCrosspostMaterial(pool, { ownerId: OWNER_A, draftId: draft.id, text: '二通目', expiresAt: later() }),
      );
      expect(second.material_text).toBe('一通目\n二通目');
      expect(
        await appendCrosspostMaterial(pool, { ownerId: OWNER_A, draftId: draft.id, text: 'あ'.repeat(1995), expiresAt: later() }),
      ).toEqual({ ok: false, error: 'TOO_LONG' });
      // 他のオーナーは追記できない
      expect(
        await appendCrosspostMaterial(pool, { ownerId: OWNER_B, draftId: draft.id, text: '乗っ取り', expiresAt: later() }),
      ).toEqual({ ok: false, error: 'NOT_COLLECTING' });
      const reread = await getCrosspostDraft(pool, { ownerId: OWNER_A, draftId: draft.id });
      expect(reread?.draft.material_text).toBe('一通目\n二通目');
    });

    it('素材が空なら確認中へ進めない。進んだ後の追記は NOT_COLLECTING', async () => {
      const pool = await getPool();
      const draft = unwrap(
        await createCrosspostDraft(pool, {
          ownerId: OWNER_A,
          storeId: STORE_A1,
          allowedStoreIds: ALLOWED,
          expiresAt: later(),
          purgeAfter: purgeLater(),
        }),
      );
      expect(await beginCrosspostReview(pool, { ownerId: OWNER_A, draftId: draft.id, expiresAt: later() })).toBeNull();
      unwrap(await appendCrosspostMaterial(pool, { ownerId: OWNER_A, draftId: draft.id, text: '本日限定', expiresAt: later() }));
      const reviewing = await beginCrosspostReview(pool, { ownerId: OWNER_A, draftId: draft.id, expiresAt: later() });
      expect(reviewing?.status).toBe('reviewing');
      expect(reviewing?.revision).toBe(1);
      expect(
        await appendCrosspostMaterial(pool, { ownerId: OWNER_A, draftId: draft.id, text: '遅れて届いた文', expiresAt: later() }),
      ).toEqual({ ok: false, error: 'NOT_COLLECTING' });
    });
  });

  describe('文の保存と入力モード', () => {
    it('版が一致したときだけ保存し、版を進め、入力モードを戻す', async () => {
      const pool = await getPool();
      const draft = await newReviewingDraft();
      const moded = await setCrosspostInputMode(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        expectedRevision: draft.revision,
        mode: 'manual',
        destination: 'google',
        expiresAt: later(),
      });
      expect(moded?.input_mode).toBe('manual');
      expect(moded?.revision).toBe(draft.revision); // モードの切替では版を進めない

      expect(
        await saveCrosspostTexts(pool, {
          ownerId: OWNER_A,
          draftId: draft.id,
          expectedRevision: draft.revision - 1,
          texts: { google: '古い版から' },
          expiresAt: later(),
        }),
      ).toBeNull();

      const saved = await saveCrosspostTexts(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        expectedRevision: draft.revision,
        texts: { google: '書き直した文' },
        appendMaterial: '修正指示',
        expiresAt: later(),
      });
      expect(saved?.google_text).toBe('書き直した文');
      expect(saved?.instagram_text).toBe('IG本文'); // 渡していない投稿先は変えない
      expect(saved?.material_text).toBe('新メニューの告知\n修正指示');
      expect(saved?.revision).toBe(draft.revision + 1);
      expect(saved?.input_mode).toBe('none');
      expect(saved?.input_destination).toBeNull();
    });

    it('他のオーナーは文を保存できない', async () => {
      const pool = await getPool();
      const draft = await newReviewingDraft();
      expect(
        await saveCrosspostTexts(pool, {
          ownerId: OWNER_B,
          draftId: draft.id,
          expectedRevision: draft.revision,
          texts: { google: '乗っ取り' },
          expiresAt: later(),
        }),
      ).toBeNull();
    });
  });

  describe('写真', () => {
    it('同じ LINE のメッセージは重複として扱い、新しい写真は差し替えて古い名前を返す。版を進める', async () => {
      const pool = await getPool();
      const draft = await newReviewingDraft();
      const first = await attachCrosspostMedia(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        media: mediaInput('m-1'),
        expiresAt: later(),
      });
      if (first.kind !== 'attached') throw new Error(first.kind);
      expect(first.replacedStorageKeys).toEqual([]);
      expect(first.draft.revision).toBe(draft.revision + 1);

      const dup = await attachCrosspostMedia(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        media: mediaInput('m-1'),
        expiresAt: later(),
      });
      expect(dup.kind).toBe('duplicate');

      const second = await attachCrosspostMedia(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        media: mediaInput('m-2'),
        expiresAt: later(),
      });
      if (second.kind !== 'attached') throw new Error(second.kind);
      expect(second.replacedStorageKeys).toEqual([first.media.storage_key]);
      expect((await getCrosspostMedia(pool, { ownerId: OWNER_A, draftId: draft.id }))?.line_message_id).toBe('m-2');
    });

    it('他のオーナー・作成中でない下書きへは付けない', async () => {
      const pool = await getPool();
      const draft = await newReviewingDraft();
      expect(
        (await attachCrosspostMedia(pool, { ownerId: OWNER_B, draftId: draft.id, media: mediaInput('x'), expiresAt: later() }))
          .kind,
      ).toBe('not_open');
      await closeCrosspostDraft(pool, { ownerId: OWNER_A, draftId: draft.id });
      expect(
        (await attachCrosspostMedia(pool, { ownerId: OWNER_A, draftId: draft.id, media: mediaInput('y'), expiresAt: later() }))
          .kind,
      ).toBe('not_open');
    });

    it('並行して届いた 2 枚の写真は直列になり、行は 1 つだけ残る', async () => {
      const pool = await getPool();
      const draft = await newReviewingDraft();
      const results = await Promise.all([
        attachCrosspostMedia(pool, { ownerId: OWNER_A, draftId: draft.id, media: mediaInput('p-1'), expiresAt: later() }),
        attachCrosspostMedia(pool, { ownerId: OWNER_A, draftId: draft.id, media: mediaInput('p-2'), expiresAt: later() }),
      ]);
      expect(results.every((r) => r.kind === 'attached')).toBe(true);
      const count = await pool.query('SELECT count(*)::int AS n FROM crosspost_media WHERE draft_id = $1', [draft.id]);
      expect(count.rows[0].n).toBe(1);
    });
  });

  describe('取り消しと期限切れ', () => {
    it('取り消すと写真の行を消して名前を返す。2 回目は null', async () => {
      const pool = await getPool();
      const draft = await newReviewingDraft();
      const attached = await attachCrosspostMedia(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        media: mediaInput('c-1'),
        expiresAt: later(),
      });
      if (attached.kind !== 'attached') throw new Error(attached.kind);
      expect(await closeCrosspostDraft(pool, { ownerId: OWNER_B, draftId: draft.id })).toBeNull();
      const closed = await closeCrosspostDraft(pool, { ownerId: OWNER_A, draftId: draft.id });
      expect(closed).toEqual({ draftId: draft.id, removedStorageKeys: [attached.media.storage_key] });
      expect(await closeCrosspostDraft(pool, { ownerId: OWNER_A, draftId: draft.id })).toBeNull();
      expect(await getOpenCrosspostDraft(pool, OWNER_A)).toBeNull();
    });

    it('onlyIfExpiredAt は期限内の下書きを閉じない', async () => {
      const pool = await getPool();
      const draft = await newReviewingDraft();
      expect(await closeCrosspostDraft(pool, { ownerId: OWNER_A, draftId: draft.id, onlyIfExpiredAt: new Date() })).toBeNull();
      const closed = await closeCrosspostDraft(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        onlyIfExpiredAt: new Date(Date.now() + 48 * 3600 * 1000),
      });
      expect(closed?.draftId).toBe(draft.id);
    });
  });

  describe('承認', () => {
    it('版が一致すれば承認し、選んだ投稿先ごとに本文の写しを作る。二重の承認は stale', async () => {
      const pool = await getPool();
      const draft = await newReviewingDraft();
      const attached = await attachCrosspostMedia(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        media: mediaInput('a-1'),
        expiresAt: later(),
      });
      if (attached.kind !== 'attached') throw new Error(attached.kind);
      const revision = attached.draft.revision;

      expect(
        await approveCrosspostDraft(pool, {
          ownerId: OWNER_A,
          draftId: draft.id,
          expectedRevision: revision - 1,
          destinations: ['instagram', 'google'],
        }),
      ).toEqual({ kind: 'stale' });

      const [one, two] = await Promise.all([
        approveCrosspostDraft(pool, { ownerId: OWNER_A, draftId: draft.id, expectedRevision: revision, destinations: ['instagram', 'google'] }),
        approveCrosspostDraft(pool, { ownerId: OWNER_A, draftId: draft.id, expectedRevision: revision, destinations: ['instagram', 'google'] }),
      ]);
      const outcomes = [one, two];
      expect(outcomes.filter((o) => o.kind === 'approved')).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === 'stale')).toHaveLength(1);
      const approved = outcomes.find((o) => o.kind === 'approved');
      if (approved?.kind !== 'approved') throw new Error('not approved');
      expect(approved.draft.status).toBe('approved');
      expect(approved.draft.approved_revision).toBe(revision);
      const byDest = Object.fromEntries(approved.deliveries.map((d) => [d.destination, d]));
      expect(byDest.instagram?.body_text).toBe('IG本文');
      expect(byDest.google?.body_text).toBe('Google本文');
      expect(byDest.google?.with_media).toBe(true);
      expect(byDest.google?.media_id).toBe(attached.media.id);
      expect(byDest.google?.status).toBe('queued');

      // 承認の後は文を変えられない
      expect(
        await saveCrosspostTexts(pool, {
          ownerId: OWNER_A,
          draftId: draft.id,
          expectedRevision: revision,
          texts: { google: '承認後の変更' },
          expiresAt: later(),
        }),
      ).toBeNull();
      const deliveries = await listCrosspostDeliveries(pool, { ownerId: OWNER_A, draftId: draft.id });
      expect(deliveries.find((d) => d.delivery.destination === 'google')?.delivery.body_text).toBe('Google本文');
    });

    it('選んだ投稿先の文が無ければ承認しない', async () => {
      const pool = await getPool();
      const draft = await newReviewingDraft(OWNER_A, STORE_A1, { google: 'Googleだけ' });
      expect(
        await approveCrosspostDraft(pool, {
          ownerId: OWNER_A,
          draftId: draft.id,
          expectedRevision: draft.revision,
          destinations: ['instagram'],
        }),
      ).toEqual({ kind: 'stale' });
      const ok = await approveCrosspostDraft(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        expectedRevision: draft.revision,
        destinations: ['google'],
      });
      expect(ok.kind).toBe('approved');
    });

    it('他のオーナー・停止した店舗の下書きは承認しない', async () => {
      const pool = await getPool();
      const draft = await newReviewingDraft();
      expect(
        await approveCrosspostDraft(pool, { ownerId: OWNER_B, draftId: draft.id, expectedRevision: draft.revision, destinations: ['google'] }),
      ).toEqual({ kind: 'stale' });
      await pool.query('UPDATE stores SET suspended_at = now() WHERE id = $1', [STORE_A1]);
      try {
        expect(
          await approveCrosspostDraft(pool, { ownerId: OWNER_A, draftId: draft.id, expectedRevision: draft.revision, destinations: ['google'] }),
        ).toEqual({ kind: 'stale' });
        const open = await getOpenCrosspostDraft(pool, OWNER_A);
        expect(open?.serviceable).toBe(false);
      } finally {
        await pool.query('UPDATE stores SET suspended_at = NULL WHERE id = $1', [STORE_A1]);
      }
    });
  });

  describe('投稿先の実行権と結果', () => {
    async function approvedGoogle(): Promise<{ draftId: string; deliveryId: string }> {
      const pool = await getPool();
      const draft = await newReviewingDraft();
      const approved = await approveCrosspostDraft(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        expectedRevision: draft.revision,
        destinations: ['google'],
      });
      if (approved.kind !== 'approved') throw new Error('not approved');
      return { draftId: draft.id, deliveryId: approved.deliveries[0]!.id };
    }

    it('並行した獲得で実行権を得るのは 1 つだけ。他のオーナーは獲得できない', async () => {
      const pool = await getPool();
      const { deliveryId } = await approvedGoogle();
      expect(
        await claimCrosspostDelivery(pool, { ownerId: OWNER_B, deliveryId, mode: 'first', maxAttempts: MAX_ATTEMPTS }),
      ).toBeNull();
      const claims = await Promise.all([
        claimCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, mode: 'first', maxAttempts: MAX_ATTEMPTS }),
        claimCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, mode: 'first', maxAttempts: MAX_ATTEMPTS }),
      ]);
      expect(claims.filter((c) => c !== null)).toHaveLength(1);
      const claimed = claims.find((c) => c !== null)!;
      expect(claimed.status).toBe('in_progress');
      expect(claimed.attempt_count).toBe(1);
    });

    it('古い試行の結果・checkpoint は書かない', async () => {
      const pool = await getPool();
      const { deliveryId } = await approvedGoogle();
      const claimed = await claimCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, mode: 'first', maxAttempts: MAX_ATTEMPTS });
      expect(claimed).not.toBeNull();
      expect(await saveCrosspostCheckpoint(pool, { deliveryId, attempt: 1, checkpoint: 'container-1' })).toBe(true);
      expect(await saveCrosspostCheckpoint(pool, { deliveryId, attempt: 2, checkpoint: 'stale' })).toBe(false);
      expect(
        await recordCrosspostOutcome(pool, {
          deliveryId,
          attempt: 2,
          outcome: { kind: 'succeeded', externalId: 'x', externalUrl: null },
        }),
      ).toBeNull();
      const failed = await recordCrosspostOutcome(pool, {
        deliveryId,
        attempt: 1,
        outcome: { kind: 'failed', reason: 'rate_limited', retryable: true },
      });
      expect(failed?.status).toBe('failed');
      expect(failed?.checkpoint).toBe('container-1');
      // 記録の後は同じ試行でも書けない（in_progress でない）
      expect(
        await recordCrosspostOutcome(pool, { deliveryId, attempt: 1, outcome: { kind: 'unknown', reason: 'timeout' } }),
      ).toBeNull();
    });

    it('再試行は retryable な failed だけ・回数の上限まで。first では獲得しない', async () => {
      const pool = await getPool();
      const { deliveryId } = await approvedGoogle();
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const mode = attempt === 1 ? 'first' : 'retry';
        const claimed = await claimCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, mode, maxAttempts: MAX_ATTEMPTS });
        expect(claimed?.attempt_count).toBe(attempt);
        expect(
          await claimCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, mode: 'first', maxAttempts: MAX_ATTEMPTS }),
        ).toBeNull();
        await recordCrosspostOutcome(pool, {
          deliveryId,
          attempt,
          outcome: { kind: 'failed', reason: 'rate_limited', retryable: true },
        });
      }
      expect(
        await claimCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, mode: 'retry', maxAttempts: MAX_ATTEMPTS }),
      ).toBeNull();
    });

    it('再試行できない failed・succeeded・unknown は獲得できない', async () => {
      const pool = await getPool();
      for (const outcome of [
        { kind: 'failed', reason: 'permission_denied', retryable: false } as const,
        { kind: 'succeeded', externalId: 'p', externalUrl: null } as const,
        { kind: 'unknown', reason: 'timeout' } as const,
      ]) {
        const { deliveryId } = await approvedGoogle();
        await claimCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, mode: 'first', maxAttempts: MAX_ATTEMPTS });
        await recordCrosspostOutcome(pool, { deliveryId, attempt: 1, outcome });
        expect(
          await claimCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, mode: 'retry', maxAttempts: MAX_ATTEMPTS }),
        ).toBeNull();
        await resetCrosspost();
      }
    });

    it('結果不明は店主の確認で成功か、再試行できる失敗に移る', async () => {
      const pool = await getPool();
      const { deliveryId } = await approvedGoogle();
      await claimCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, mode: 'first', maxAttempts: MAX_ATTEMPTS });
      await recordCrosspostOutcome(pool, { deliveryId, attempt: 1, outcome: { kind: 'unknown', reason: 'network' } });
      expect(await resolveUnknownCrosspostDelivery(pool, { ownerId: OWNER_B, deliveryId, posted: false })).toBeNull();
      const notPosted = await resolveUnknownCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, posted: false });
      expect(notPosted?.status).toBe('failed');
      expect(notPosted?.retryable).toBe(true);
      expect(notPosted?.failure_reason).toBe('owner_reported_not_posted');
      // 結果不明でなくなったので、もう一度確定はできない
      expect(await resolveUnknownCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, posted: true })).toBeNull();
      const retried = await claimCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, mode: 'retry', maxAttempts: MAX_ATTEMPTS });
      expect(retried?.attempt_count).toBe(2);
    });

    it('実行中のまま古くなった行は結果不明になる（そのオーナーの行だけ）', async () => {
      const pool = await getPool();
      const { deliveryId } = await approvedGoogle();
      await claimCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, mode: 'first', maxAttempts: MAX_ATTEMPTS });
      await pool.query(`UPDATE crosspost_deliveries SET last_attempt_at = now() - interval '10 minutes' WHERE id = $1`, [deliveryId]);
      expect(await markStaleCrosspostDeliveries(pool, { ownerId: OWNER_B, olderThan: new Date(Date.now() - 5 * 60_000) })).toBe(0);
      expect(await markStaleCrosspostDeliveries(pool, { ownerId: OWNER_A, olderThan: new Date(Date.now() - 5 * 60_000) })).toBe(1);
      const ctx = await getCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId });
      expect(ctx?.delivery.status).toBe('unknown');
      expect(ctx?.delivery.unknown_reason).toBe('stale_in_progress');
      // 遅れて戻った試行は結果を書けない
      expect(
        await recordCrosspostOutcome(pool, {
          deliveryId,
          attempt: 1,
          outcome: { kind: 'succeeded', externalId: null, externalUrl: null },
        }),
      ).toBeNull();
    });

    it('投稿が終わった下書きの写真だけを消す', async () => {
      const pool = await getPool();
      const draft = await newReviewingDraft();
      const attached = await attachCrosspostMedia(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        media: mediaInput('r-1'),
        expiresAt: later(),
      });
      if (attached.kind !== 'attached') throw new Error(attached.kind);
      const approved = await approveCrosspostDraft(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        expectedRevision: attached.draft.revision,
        destinations: ['google'],
      });
      if (approved.kind !== 'approved') throw new Error('not approved');
      const deliveryId = approved.deliveries[0]!.id;
      // まだ待ち（queued）なので消さない
      expect(await releaseSettledCrosspostMedia(pool, { ownerId: OWNER_A, draftId: draft.id, maxAttempts: MAX_ATTEMPTS })).toEqual([]);
      await claimCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId, mode: 'first', maxAttempts: MAX_ATTEMPTS });
      await recordCrosspostOutcome(pool, {
        deliveryId,
        attempt: 1,
        outcome: { kind: 'succeeded', externalId: 'localPosts/1', externalUrl: null },
      });
      expect(await releaseSettledCrosspostMedia(pool, { ownerId: OWNER_B, draftId: draft.id, maxAttempts: MAX_ATTEMPTS })).toEqual([]);
      expect(await releaseSettledCrosspostMedia(pool, { ownerId: OWNER_A, draftId: draft.id, maxAttempts: MAX_ATTEMPTS })).toEqual([
        attached.media.storage_key,
      ]);
      const ctx = await getCrosspostDelivery(pool, { ownerId: OWNER_A, deliveryId });
      expect(ctx?.delivery.media_id).toBeNull();
      expect(ctx?.delivery.with_media).toBe(true);
    });

    it('直近の投稿の一覧はそのオーナーの承認済みだけ', async () => {
      const pool = await getPool();
      await approvedGoogle();
      const mine = await listRecentCrosspostPosts(pool, { ownerId: OWNER_A, limit: 5 });
      expect(mine).toHaveLength(1);
      expect(mine[0]?.storeName).toBe('A店1');
      expect(mine[0]?.deliveries.map((d) => d.destination)).toEqual(['google']);
      expect(await listRecentCrosspostPosts(pool, { ownerId: OWNER_B, limit: 5 })).toEqual([]);
    });
  });

  describe('保存期間と制約', () => {
    it('保存期間を過ぎた下書きを消し、写真の名前を返す', async () => {
      const pool = await getPool();
      const draft = await newReviewingDraft();
      const attached = await attachCrosspostMedia(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        media: mediaInput('g-1'),
        expiresAt: later(),
      });
      if (attached.kind !== 'attached') throw new Error(attached.kind);
      const purged = await purgeExpiredCrosspostDrafts(pool, { now: new Date(Date.now() + 31 * 24 * 3600 * 1000), limit: 100 });
      expect(purged.deletedDrafts).toBeGreaterThanOrEqual(1);
      expect(purged.removedStorageKeys).toContain(attached.media.storage_key);
      expect(await getCrosspostDraft(pool, { ownerId: OWNER_A, draftId: draft.id })).toBeNull();
    });

    it('状態と付随列が食い違う行は CHECK が拒否する', async () => {
      const pool = await getPool();
      const draft = await newReviewingDraft();
      const approved = await approveCrosspostDraft(pool, {
        ownerId: OWNER_A,
        draftId: draft.id,
        expectedRevision: draft.revision,
        destinations: ['google'],
      });
      if (approved.kind !== 'approved') throw new Error('not approved');
      const id = approved.deliveries[0]!.id;
      await expect(
        pool.query(`UPDATE crosspost_deliveries SET status = 'failed', finished_at = now(), last_attempt_at = now() WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        pool.query(
          `UPDATE crosspost_deliveries SET status = 'succeeded', retryable = true, finished_at = now(), last_attempt_at = now() WHERE id = $1`,
          [id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        pool.query(`UPDATE crosspost_drafts SET status = 'collecting' WHERE id = $1`, [draft.id]),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
type Pool = Awaited<ReturnType<typeof getPool>>;
import {
  appendCrosspostMaterial,
  attachCrosspostMedia,
  beginCrosspostReview,
  closePool,
  createCrosspostDraft,
  getCrosspostDelivery,
  getPool,
  listCrosspostDeliveries,
  saveCrosspostTexts,
  type CrosspostDraftRow,
} from '@fwlm/db';
import { createCrosspostPublisher, type CrosspostPublisher } from '../../src/crosspost/publisher.js';
import {
  clearCrosspost,
  fakeAdapter,
  memoryMediaStore,
  recordingLogger,
  seedFixture,
  withReconcile,
  type FakeAdapter,
  type Fixture,
  type MemoryMediaStore,
} from './support.js';

const later = (): Date => new Date(Date.now() + 3600_000);

describe.skipIf(!process.env.DATABASE_URL)('crosspost publisher (DB)', () => {
  let pool: Pool;
  let f: Fixture;
  let instagram: FakeAdapter;
  let google: FakeAdapter;
  let store: MemoryMediaStore;
  let publisher: CrosspostPublisher;

  function build(options: { canIssueFetchUrl?: boolean; timeoutsMs?: { instagram: number; google: number } } = {}) {
    store = memoryMediaStore(options.canIssueFetchUrl ?? true);
    publisher = createCrosspostPublisher({
      db: pool,
      pool,
      adapters: { instagram, google },
      mediaStore: store,
      logger: recordingLogger(),
      ...(options.timeoutsMs ? { timeoutsMs: options.timeoutsMs } : {}),
    });
  }

  async function reviewingDraft(withMedia = false): Promise<CrosspostDraftRow> {
    const created = await createCrosspostDraft(pool, {
      ownerId: f.owner,
      storeId: f.store,
      allowedStoreIds: [f.store, f.store2],
      expiresAt: later(),
      purgeAfter: new Date(Date.now() + 30 * 86400_000),
    });
    if (!created.ok) throw new Error(created.error);
    await appendCrosspostMaterial(pool, { ownerId: f.owner, draftId: created.value.id, text: '新作の抹茶パフェ', expiresAt: later() });
    let draft = (await beginCrosspostReview(pool, { ownerId: f.owner, draftId: created.value.id, expiresAt: later() }))!;
    draft = (await saveCrosspostTexts(pool, {
      ownerId: f.owner,
      draftId: draft.id,
      expectedRevision: draft.revision,
      texts: { instagram: 'IGの文', google: 'Googleの文' },
      expiresAt: later(),
    }))!;
    if (withMedia) {
      const key = `crosspost/${crypto.randomUUID()}.jpg`;
      await store.put({ key, bytes: Buffer.from('jpeg'), contentType: 'image/jpeg' });
      const attached = await attachCrosspostMedia(pool, {
        ownerId: f.owner,
        draftId: draft.id,
        media: { lineMessageId: '100', storageKey: key, contentType: 'image/jpeg', width: 1080, height: 1080, byteSize: 9000, sha256: 'b'.repeat(64) },
        expiresAt: later(),
      });
      if (attached.kind !== 'attached') throw new Error(attached.kind);
      draft = attached.draft;
    }
    return draft;
  }

  async function approveBoth(draft: CrosspostDraftRow, destinations: ('instagram' | 'google')[] = ['instagram', 'google']) {
    return publisher.approve({ ownerId: f.owner, storeId: f.store, draftId: draft.id, revision: draft.revision, destinations });
  }

  beforeAll(async () => {
    pool = await getPool();
    f = await seedFixture(pool, '3d');
  });

  beforeEach(async () => {
    await clearCrosspost(pool, [f.owner, f.otherOwner]);
    instagram = fakeAdapter('instagram');
    google = fakeAdapter('google');
    build();
  });

  afterAll(async () => {
    await clearCrosspost(pool, [f.owner, f.otherOwner]);
    await closePool();
  });

  it('選んだ投稿先が使えなければ承認しない（行を作らない）', async () => {
    instagram.availabilityResult = { kind: 'not_ready' };
    const draft = await reviewingDraft();
    const result = await approveBoth(draft);
    expect(result.kind).toBe('unavailable');
    expect(await listCrosspostDeliveries(pool, { ownerId: f.owner, draftId: draft.id })).toEqual([]);
  });

  it('写真付きで、写真を渡す手段が無ければ「写真付きは準備中」として使えない', async () => {
    build({ canIssueFetchUrl: false });
    const draft = await reviewingDraft(true);
    const availability = await publisher.availability({ ownerId: f.owner, storeId: f.store, draftId: draft.id });
    expect(availability.google).toEqual({ kind: 'unsupported_content', issue: 'media_not_deliverable' });
    expect((await approveBoth(draft, ['google'])).kind).toBe('unavailable');
  });

  it('片方成功・片方失敗を投稿先ごとに保持し、成功した投稿先へは二度と送らない', async () => {
    google.behaviors = [async () => ({ kind: 'failed', reason: 'rate_limited', retryable: true })];
    const draft = await reviewingDraft();
    expect((await approveBoth(draft)).kind).toBe('approved');
    const results = await publisher.runApproved(f.owner, draft.id);
    expect(results.map((r) => [r.delivery.destination, r.delivery.status])).toEqual([
      ['instagram', 'succeeded'],
      ['google', 'failed'],
    ]);
    expect(results[0]!.delivery.external_id).toBe('instagram-post-1');
    expect(results[1]!.delivery.retryable).toBe(true);

    // もう一度実行しても、待ちの行が無いので何も送らない
    await publisher.runApproved(f.owner, draft.id);
    expect(instagram.calls).toHaveLength(1);
    expect(google.calls).toHaveLength(1);

    // 失敗した Google だけを再試行できる。成功した Instagram は再試行できない
    google.behaviors = [async () => ({ kind: 'succeeded', externalId: 'g-2', externalUrl: null })];
    const retried = await publisher.retry(f.owner, results[1]!.delivery.id);
    expect(retried.kind).toBe('ran');
    expect(retried.kind === 'ran' && retried.delivery.delivery.status).toBe('succeeded');
    expect(retried.kind === 'ran' && retried.delivery.delivery.attempt_count).toBe(2);
    expect((await publisher.retry(f.owner, results[0]!.delivery.id)).kind).toBe('not_retryable');
    expect(instagram.calls).toHaveLength(1);
  });

  it('承認した本文の写しを送る（承認の後の変更は反映しない）', async () => {
    const draft = await reviewingDraft();
    await approveBoth(draft, ['google']);
    await pool.query(`UPDATE crosspost_drafts SET google_text = google_text WHERE id = $1`, [draft.id]);
    await publisher.runApproved(f.owner, draft.id);
    expect(google.calls[0]!.bodyText).toBe('Googleの文');
  });

  it('二重の承認・並行した実行でも、投稿先ごとに高々 1 回だけ送る', async () => {
    const draft = await reviewingDraft();
    const approvals = await Promise.all([approveBoth(draft), approveBoth(draft)]);
    expect(approvals.filter((a) => a.kind === 'approved')).toHaveLength(1);
    expect(approvals.filter((a) => a.kind === 'stale')).toHaveLength(1);
    await Promise.all([publisher.runApproved(f.owner, draft.id), publisher.runApproved(f.owner, draft.id)]);
    expect(instagram.calls).toHaveLength(1);
    expect(google.calls).toHaveLength(1);
  });

  it('応答の喪失（unknown）・アダプタの例外は結果不明にし、自動で再投稿しない', async () => {
    instagram.behaviors = [async () => ({ kind: 'unknown', reason: 'network' })];
    google.behaviors = [
      async () => {
        throw new Error('boom');
      },
    ];
    const draft = await reviewingDraft();
    await approveBoth(draft);
    const results = await publisher.runApproved(f.owner, draft.id);
    expect(results.map((r) => [r.delivery.status, r.delivery.unknown_reason])).toEqual([
      ['unknown', 'network'],
      ['unknown', 'adapter_threw'],
    ]);
    expect((await publisher.retry(f.owner, results[0]!.delivery.id)).kind).toBe('not_retryable');
    expect(instagram.calls).toHaveLength(1);
  });

  it('時間切れ（アダプタが応答しない）は結果不明にする', async () => {
    build({ timeoutsMs: { instagram: 30, google: 30 } });
    google.behaviors = [() => new Promise<never>(() => {})];
    const draft = await reviewingDraft();
    await approveBoth(draft, ['google']);
    const results = await publisher.runApproved(f.owner, draft.id);
    expect(results[0]!.delivery.status).toBe('unknown');
    expect(results[0]!.delivery.unknown_reason).toBe('timeout');
    expect(google.calls[0]!.signal.aborted).toBe(true);
  }, 10_000);

  it('途中の到達点を保存し、店主が「投稿されていなかった」と確かめた後の再試行で使う', async () => {
    instagram.behaviors = [
      async (_input, save) => {
        await save('container-123');
        return { kind: 'unknown', reason: 'timeout' };
      },
      async () => ({ kind: 'succeeded', externalId: 'ig-media-9', externalUrl: null }),
    ];
    const draft = await reviewingDraft();
    await approveBoth(draft, ['instagram']);
    const [first] = await publisher.runApproved(f.owner, draft.id);
    expect(first!.delivery.checkpoint).toBe('container-123');

    // 照合の手段が無い投稿先は、店主による確認に倒す
    expect((await publisher.reconcile(f.owner, first!.delivery.id)).kind).toBe('needs_owner');
    expect(await publisher.markObserved(f.otherOwner, first!.delivery.id, false)).toBeNull();
    const observed = await publisher.markObserved(f.owner, first!.delivery.id, false);
    expect(observed?.delivery.status).toBe('failed');
    const retried = await publisher.retry(f.owner, first!.delivery.id);
    expect(retried.kind).toBe('ran');
    expect(instagram.calls[1]!.checkpoint).toBe('container-123');
  });

  it('照合の手段がある投稿先は照合で結果を確定する', async () => {
    withReconcile(google, { kind: 'posted', externalId: 'localPosts/9', externalUrl: null });
    google.behaviors = [async () => ({ kind: 'unknown', reason: 'upstream_5xx' })];
    const draft = await reviewingDraft();
    await approveBoth(draft, ['google']);
    const [first] = await publisher.runApproved(f.owner, draft.id);
    const reconciled = await publisher.reconcile(f.owner, first!.delivery.id);
    expect(reconciled.kind).toBe('resolved');
    expect(reconciled.delivery?.delivery.status).toBe('succeeded');
    expect(reconciled.delivery?.delivery.external_id).toBe('localPosts/9');
  });

  it('写真付きの投稿は取得用 URL を渡し、終わったら写真を消す。他のオーナーは再試行・照合できない', async () => {
    const draft = await reviewingDraft(true);
    await approveBoth(draft, ['google']);
    const [result] = await publisher.runApproved(f.owner, draft.id);
    expect(google.calls[0]!.media?.fetchUrl).toMatch(/^https:\/\/media\.example\.test\//);
    expect(result!.delivery.status).toBe('succeeded');
    expect(store.deleted).toHaveLength(1);
    expect(store.objects.size).toBe(0);
    expect((await publisher.retry(f.otherOwner, result!.delivery.id)).kind).toBe('not_retryable');
    expect((await publisher.reconcile(f.otherOwner, result!.delivery.id)).kind).toBe('not_unknown');
  });

  it('写真付きで承認したのに写真の行が無ければ、写真を落として送らない', async () => {
    const draft = await reviewingDraft(true);
    await approveBoth(draft, ['google']);
    await pool.query('DELETE FROM crosspost_media WHERE draft_id = $1', [draft.id]);
    const [result] = await publisher.runApproved(f.owner, draft.id);
    expect(result!.delivery.status).toBe('failed');
    expect(result!.delivery.failure_reason).toBe('media_unavailable');
    expect(google.calls).toHaveLength(0);
  });

  it('実行中のまま古くなった行は、状況の確認の前に結果不明へ移す', async () => {
    const draft = await reviewingDraft();
    await approveBoth(draft, ['google']);
    const [queued] = await listCrosspostDeliveries(pool, { ownerId: f.owner, draftId: draft.id });
    await pool.query(
      `UPDATE crosspost_deliveries SET status = 'in_progress', attempt_count = 1, last_attempt_at = now() - interval '10 minutes' WHERE id = $1`,
      [queued!.delivery.id],
    );
    await publisher.reapStale(f.owner);
    const after = await getCrosspostDelivery(pool, { ownerId: f.owner, deliveryId: queued!.delivery.id });
    expect(after?.delivery.status).toBe('unknown');
    expect(after?.delivery.unknown_reason).toBe('stale_in_progress');
  });
});

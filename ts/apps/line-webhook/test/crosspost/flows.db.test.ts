import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
type Pool = Awaited<ReturnType<typeof getPool>>;
import { closePool, getCrosspostMedia, getOpenCrosspostDraft, getPool, listRecentCrosspostPosts } from '@fwlm/db';
import { createCrosspostFlows, type CrosspostEventBase, type CrosspostFlows } from '../../src/crosspost/flows.js';
import { createPhotoIntake } from '../../src/crosspost/intake.js';
import { encodeCrosspostPostback, type CrosspostPostback } from '../../src/crosspost/postback.js';
import { createCrosspostPublisher, type CrosspostPublisher } from '../../src/crosspost/publisher.js';
import type { MessageContentResult } from '../../src/line/client.js';
import {
  clearCrosspost,
  fakeAdapter,
  fakeMessenger,
  fakePrompts,
  flatten,
  memoryMediaStore,
  recordingLogger,
  seedFixture,
  type FakeAdapter,
  type FakeMessenger,
  type Fixture,
  type MemoryMediaStore,
} from './support.js';

describe.skipIf(!process.env.DATABASE_URL)('crosspost flows (DB)', () => {
  let pool: Pool;
  let f: Fixture;
  let messenger: FakeMessenger;
  let instagram: FakeAdapter;
  let google: FakeAdapter;
  let store: MemoryMediaStore;
  let prompts: ReturnType<typeof fakePrompts>;
  let flows: CrosspostFlows;
  let publisher: CrosspostPublisher;
  let contents: Map<string, MessageContentResult>;
  let pilot: string[];
  let jpeg: Buffer;
  let seq = 0;

  function build(): void {
    messenger = fakeMessenger();
    store = memoryMediaStore(true);
    prompts = fakePrompts();
    const logger = recordingLogger();
    publisher = createCrosspostPublisher({ db: pool, pool, adapters: { instagram, google }, mediaStore: store, logger });
    flows = createCrosspostFlows({
      db: pool,
      pool,
      messenger,
      prompts,
      publisher,
      intake: createPhotoIntake({
        pool,
        mediaStore: store,
        fetchContent: async (messageId) => contents.get(messageId) ?? { kind: 'gone' },
        logger,
      }),
      mediaStore: store,
      logger,
      pilotStoreIds: pilot,
      googleConnectAvailable: true,
    });
  }

  const event = (ownerId = f.owner): CrosspostEventBase => {
    seq += 1;
    return { ownerId, lineUserId: 'U-flow', replyToken: `rt-${seq}` };
  };
  const post = (data: CrosspostPostback, ownerId = f.owner) =>
    flows.handlePostback({ ...event(ownerId), data: encodeCrosspostPostback(data) });
  const say = (text: string, ownerId = f.owner) => flows.handleText({ ...event(ownerId), text });
  const photo = (messageId: string, imageSet: { id: string; index: number; total: number } | null = null) =>
    flows.handleImage({ ...event(), image: { messageId, contentProvider: 'line', imageSet, quoteToken: `qt-${messageId}` } });
  const lastReply = (): string => flatten(messenger.replies.at(-1)?.messages ?? []);
  const openDraft = async () => (await getOpenCrosspostDraft(pool, f.owner))?.draft ?? null;

  beforeAll(async () => {
    pool = await getPool();
    f = await seedFixture(pool, '3e');
    jpeg = await sharp({ create: { width: 1200, height: 1200, channels: 3, background: '#6a4' } }).jpeg().toBuffer();
  });

  beforeEach(async () => {
    await clearCrosspost(pool, [f.owner, f.otherOwner]);
    pilot = [f.store];
    instagram = fakeAdapter('instagram', { kind: 'not_ready' });
    google = fakeAdapter('google');
    contents = new Map([['900', { kind: 'ok', bytes: jpeg, contentType: 'image/jpeg' }]]);
    build();
  });

  afterAll(async () => {
    await clearCrosspost(pool, [f.owner, f.otherOwner]);
    await closePool();
  });

  it('本機能の有効な店舗を持たないオーナーのイベントは何も引き受けない', async () => {
    pilot = [];
    build();
    expect(await post({ action: 'x_start', storeId: null })).toBe('not_handled');
    expect(await say('投稿')).toBe('not_handled');
    expect(await photo('900')).toBe('not_handled');
    expect(await say('投稿', f.otherOwner)).toBe('not_handled');
    expect(messenger.replies).toHaveLength(0);
  });

  it('作成中の下書きが無いときの文・写真は引き受けない（既存の応答へ落ちる）', async () => {
    expect(await say('こんにちは')).toBe('not_handled');
    expect(await photo('900')).toBe('not_handled');
  });

  it('写真と文を受け取り、下書きを作り、Google だけを選んで最終確認の後に投稿する', async () => {
    expect(await say('投稿')).toBe('handled');
    expect(lastReply()).toContain('森のカフェ');
    expect(lastReply()).toContain('Instagram: 準備中');
    const draftId = (await openDraft())!.id;

    expect(await say('新作の抹茶パフェ')).toBe('handled');
    expect(await say('1日20食')).toBe('handled');
    expect(await photo('900')).toBe('handled');
    expect(lastReply()).toContain('写真を受け取りました');
    expect(store.objects.size).toBe(1);

    expect(await post({ action: 'x_gen', draftId })).toBe('handled');
    expect(prompts.requests[0]!.material.materialText).toBe('新作の抹茶パフェ\n1日20食');
    expect(prompts.requests[0]!.destinations).toEqual(['instagram', 'google']);
    const review = lastReply();
    expect(review).toContain('Instagram 用');
    expect(review).toContain('Google だけに投稿');
    expect(review).not.toContain('Instagram と Google に投稿'); // Instagram は準備中
    expect(review).toContain('"type":"clipboard"');

    const draft = (await openDraft())!;
    // 投稿先を選んだだけでは投稿しない
    await post({ action: 'x_conf', draftId, revision: draft.revision, choice: 'google' });
    expect(lastReply()).toContain('投稿する');
    expect(google.calls).toHaveLength(0);

    await post({ action: 'x_ok', draftId, revision: draft.revision, choice: 'google' });
    expect(google.calls).toHaveLength(1);
    expect(google.calls[0]!.bodyText).toBe('google の文: 新作の抹茶パフェ\n1日20食'.replace('google の文', 'googleの文'));
    expect(lastReply()).toContain('投稿しました');
    expect(await openDraft()).toBeNull();
    expect(store.objects.size).toBe(0); // 投稿が終わった写真は消す

    // 同じ承認のボタンをもう一度押しても投稿しない
    await post({ action: 'x_ok', draftId, revision: draft.revision, choice: 'google' });
    expect(google.calls).toHaveLength(1);
  });

  it('使えない投稿先の選び方・古い版のボタンからは投稿しない', async () => {
    await say('投稿');
    const draftId = (await openDraft())!.id;
    await say('お知らせ');
    await post({ action: 'x_gen', draftId });
    const draft = (await openDraft())!;

    await post({ action: 'x_ok', draftId, revision: draft.revision, choice: 'both' }); // Instagram は準備中
    expect(lastReply()).toContain('このボタンでは投稿できません');

    // 最終確認の後に写真を差し替えると版が進み、前の最終確認からは投稿できない
    await post({ action: 'x_conf', draftId, revision: draft.revision, choice: 'google' });
    await photo('900');
    await post({ action: 'x_ok', draftId, revision: draft.revision, choice: 'google' });
    expect(lastReply()).toContain('このボタンでは投稿できません');
    expect(google.calls).toHaveLength(0);
  });

  it('他のオーナーの下書きの ID を送られても、何も変えない', async () => {
    await say('投稿');
    const draftId = (await openDraft())!.id;
    pilot = [f.store, f.otherStore];
    build();
    await post({ action: 'x_cancel', draftId }, f.otherOwner);
    await post({ action: 'x_gen', draftId }, f.otherOwner);
    expect((await openDraft())?.status).toBe('collecting');
  });

  it('有効化の指定から外した店舗の作成中の下書きは、ほかの有効な店舗を持っていても操作させずに閉じる', async () => {
    pilot = [f.store, f.store2];
    build();
    await post({ action: 'x_start', storeId: f.store });
    const draftId = (await openDraft())!.id;
    await photo('900');
    pilot = [f.store2];
    build();
    expect(await post({ action: 'x_gen', draftId })).toBe('handled');
    expect(lastReply()).toContain('このボタンでは投稿できません');
    expect(await openDraft()).toBeNull();
  });

  it('自分で書き直した文は AI を通さずに使い、AI への修正指示は 1 つの投稿先だけを作り直す', async () => {
    await say('投稿');
    const draftId = (await openDraft())!.id;
    await say('週末限定のケーキ');
    await post({ action: 'x_gen', draftId });
    let draft = (await openDraft())!;

    // 手段を選ばずに送った文は反映しない
    await say('勝手に入らない文');
    expect(lastReply()).toContain('そのままでは下書きに入りません');

    await post({ action: 'x_edit', draftId, revision: draft.revision, destination: 'google' });
    await say('  店主が書いた Google の文  ');
    draft = (await openDraft())!;
    expect(draft.google_text).toBe('店主が書いた Google の文');
    const generated = prompts.requests.length;

    await post({ action: 'x_ai', draftId, revision: draft.revision, destination: 'instagram' });
    await say('もっと短く');
    draft = (await openDraft())!;
    expect(prompts.requests).toHaveLength(generated + 1);
    expect(prompts.requests.at(-1)!.revision).toMatchObject({ destination: 'instagram', instruction: 'もっと短く' });
    expect(draft.instagram_text).toBe('instagramの直した文（もっと短く）');
    expect(draft.google_text).toBe('店主が書いた Google の文');
  });

  it('生成に失敗しても素材を失わず、作り直せる', async () => {
    await say('投稿');
    const draftId = (await openDraft())!.id;
    await say('お知らせ');
    prompts.fail = true;
    await post({ action: 'x_gen', draftId });
    expect(lastReply()).toContain('文を作れませんでした');
    const draft = (await openDraft())!;
    expect(draft.material_text).toBe('お知らせ');
    prompts.fail = false;
    await post({ action: 'x_regen', draftId, revision: draft.revision, destination: 'google' });
    expect((await openDraft())!.google_text).toBe('googleの文: お知らせ');
  });

  it('下書きを作り始めた後に届いた素材の文は黙って捨てず、知らせる', async () => {
    await say('投稿');
    const draftId = (await openDraft())!.id;
    await say('お知らせ');
    await post({ action: 'x_gen', draftId });
    await pool.query(`UPDATE crosspost_drafts SET input_mode = 'none' WHERE id = $1`, [draftId]);
    // collecting でないので追記されない（確認中の文は修正の手段を案内する）
    await say('遅れて届いた文');
    expect(lastReply()).toContain('自分で書き直す');
    expect((await openDraft())!.material_text).toBe('お知らせ');
  });

  it('まとめて送られた写真は 1 枚目だけを使い、2 枚目以降には返信しない', async () => {
    await say('投稿');
    const draftId = (await openDraft())!.id;
    contents.set('901', { kind: 'ok', bytes: jpeg, contentType: 'image/jpeg' });
    const before = messenger.replies.length;
    expect(await photo('901', { id: 's', index: 2, total: 2 })).toBe('handled');
    expect(messenger.replies).toHaveLength(before);
    expect(await photo('900', { id: 's', index: 1, total: 2 })).toBe('handled');
    expect(lastReply()).toContain('1 枚目の写真だけ');
    expect((await getCrosspostMedia(pool, { ownerId: f.owner, draftId }))?.line_message_id).toBe('900');
  });

  it('取得できない写真は理由を伝え、ほかの素材を残す', async () => {
    await say('投稿');
    await say('お知らせ');
    await photo('404');
    expect(lastReply()).toContain('写真を受け取れませんでした');
    expect((await openDraft())!.material_text).toBe('お知らせ');
  });

  it('期限切れの下書きは次の操作で閉じ、写真を消す', async () => {
    await say('投稿');
    await photo('900');
    expect(store.objects.size).toBe(1);
    await pool.query(`UPDATE crosspost_drafts SET expires_at = now() - interval '1 minute' WHERE owner_id = $1`, [f.owner]);
    expect(await say('続き')).toBe('handled');
    expect(lastReply()).toContain('時間が経ったため');
    expect(await openDraft()).toBeNull();
    expect(store.objects.size).toBe(0);
  });

  it('やめると写真を消す。作成中があるときの開始は、続けるか新しく作るかを選ばせる', async () => {
    pilot = [f.store, f.store2];
    build();
    await post({ action: 'x_start', storeId: null });
    expect(lastReply()).toContain('どの店舗の投稿を作りますか');
    await post({ action: 'x_start', storeId: f.store });
    await photo('900');
    await post({ action: 'x_start', storeId: f.store2 });
    expect(lastReply()).toContain('作成中の投稿があります');
    await post({ action: 'x_new', storeId: f.store2 });
    expect((await openDraft())!.store_id).toBe(f.store2);
    expect(store.objects.size).toBe(0);
    await post({ action: 'x_cancel', draftId: (await openDraft())!.id });
    expect(lastReply()).toContain('やめました');
    expect(await openDraft()).toBeNull();
  });

  it('結果不明の投稿は自動で送り直さず、店主の確認の後に再試行できる', async () => {
    google.behaviors = [
      async () => ({ kind: 'unknown', reason: 'network' }),
      async () => ({ kind: 'succeeded', externalId: 'g-2', externalUrl: null }),
    ];
    await say('投稿');
    const draftId = (await openDraft())!.id;
    await say('お知らせ');
    await post({ action: 'x_gen', draftId });
    const draft = (await openDraft())!;
    await post({ action: 'x_ok', draftId, revision: draft.revision, choice: 'google' });
    expect(lastReply()).toContain('確認できませんでした');
    const [recent] = await listRecentCrosspostPosts(pool, { ownerId: f.owner, limit: 1 });
    const deliveryId = recent!.deliveries[0]!.id;

    await post({ action: 'x_retry', deliveryId });
    expect(lastReply()).toContain('送り直せません');
    expect(google.calls).toHaveLength(1);

    await post({ action: 'x_seen', deliveryId, posted: false });
    await post({ action: 'x_retry', deliveryId });
    expect(google.calls).toHaveLength(2);
    expect(lastReply()).toContain('投稿しました');

    await post({ action: 'x_status' });
    expect(lastReply()).toContain('森のカフェ');
  });

  // ===================================================================
  // 障害・同時操作の再現（PR #514 のレビューで求められたシナリオ）
  // ===================================================================

  /** 下書きを確認中まで進め、その時点の下書きを返す（Instagram も使える状態にしておく）。 */
  async function reviewingDraft(withPhoto = false) {
    await say('投稿');
    const draftId = (await openDraft())!.id;
    await say('新作の抹茶パフェ');
    if (withPhoto) await photo('900');
    await post({ action: 'x_gen', draftId });
    return (await openDraft())!;
  }

  const deliveriesOf = async (draftId: string) =>
    (await pool.query<{ destination: string; status: string; attempt_count: number }>(
      'SELECT destination, status, attempt_count FROM crosspost_deliveries WHERE draft_id = $1 ORDER BY destination',
      [draftId],
    )).rows;

  describe('両方の投稿先の部分成功', () => {
    beforeEach(() => {
      instagram.availabilityResult = { kind: 'available' };
    });

    it('Instagram が失敗・Google が成功: 結果を投稿先ごとに示し、再試行は Instagram だけを送る', async () => {
      instagram.behaviors = [
        async () => ({ kind: 'failed', reason: 'rate_limited', retryable: true }),
        async () => ({ kind: 'succeeded', externalId: 'ig-2', externalUrl: null }),
      ];
      const draft = await reviewingDraft();
      await post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'both' });
      expect(lastReply()).toContain('Instagram: 投稿できませんでした');
      expect(lastReply()).toContain('Google: 投稿しました');
      const [recent] = await listRecentCrosspostPosts(pool, { ownerId: f.owner, limit: 1 });
      const ig = recent!.deliveries.find((d) => d.destination === 'instagram')!;
      await post({ action: 'x_retry', deliveryId: ig.id });
      expect(instagram.calls).toHaveLength(2);
      expect(google.calls).toHaveLength(1);
      expect(await deliveriesOf(draft.id)).toEqual([
        { destination: 'instagram', status: 'succeeded', attempt_count: 2 },
        { destination: 'google', status: 'succeeded', attempt_count: 1 },
      ]);
    });

    it('Instagram が成功・Google の通信が切断: Google は結果不明で、押し直しても送り直さない', async () => {
      google.behaviors = [async () => ({ kind: 'unknown', reason: 'network' })];
      const draft = await reviewingDraft();
      await post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'both' });
      expect(lastReply()).toContain('Instagram: 投稿しました');
      expect(lastReply()).toContain('Google: 確認できませんでした');
      // 応答が届かなかったと思って「投稿する」を押し直しても、どちらにも送り直さない
      await post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'both' });
      expect(instagram.calls).toHaveLength(1);
      expect(google.calls).toHaveLength(1);
      const [recent] = await listRecentCrosspostPosts(pool, { ownerId: f.owner, limit: 1 });
      const gg = recent!.deliveries.find((d) => d.destination === 'google')!;
      await post({ action: 'x_retry', deliveryId: gg.id });
      expect(lastReply()).toContain('送り直せません');
      expect(google.calls).toHaveLength(1);
    });
  });

  describe('結果不明の後の再試行', () => {
    it('「投稿されていた」と確かめたら成功にし、再試行の手段を出さない', async () => {
      google.behaviors = [async () => ({ kind: 'unknown', reason: 'timeout' })];
      const draft = await reviewingDraft();
      await post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'google' });
      const [recent] = await listRecentCrosspostPosts(pool, { ownerId: f.owner, limit: 1 });
      const deliveryId = recent!.deliveries[0]!.id;
      await post({ action: 'x_seen', deliveryId, posted: true });
      expect(lastReply()).toContain('Google: 投稿しました');
      await post({ action: 'x_retry', deliveryId });
      expect(google.calls).toHaveLength(1);
    });
  });

  describe('サーバーの停止', () => {
    it('承認を記録した直後に止まった（待ちのまま）: 同じ「投稿する」を押し直すと、待ちの投稿先だけを 1 回送る', async () => {
      instagram.availabilityResult = { kind: 'available' };
      const draft = await reviewingDraft();
      // 承認のトランザクションだけが終わり、実行の前にプロセスが止まった状態を作る
      const approved = await publisher.approve({
        ownerId: f.owner,
        storeId: draft.store_id,
        draftId: draft.id,
        revision: draft.revision,
        destinations: ['instagram', 'google'],
      });
      expect(approved.kind).toBe('approved');
      expect((await deliveriesOf(draft.id)).map((d) => d.status)).toEqual(['queued', 'queued']);

      await post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'both' });
      expect(instagram.calls).toHaveLength(1);
      expect(google.calls).toHaveLength(1);
      expect((await deliveriesOf(draft.id)).map((d) => d.status)).toEqual(['succeeded', 'succeeded']);
    });

    it('待ちのまま止まった投稿は「投稿の状況」から今すぐ投稿・取りやめを選べる', async () => {
      instagram.availabilityResult = { kind: 'available' };
      const draft = await reviewingDraft();
      await publisher.approve({
        ownerId: f.owner,
        storeId: draft.store_id,
        draftId: draft.id,
        revision: draft.revision,
        destinations: ['instagram', 'google'],
      });
      await post({ action: 'x_status' });
      expect(lastReply()).toContain('まだ送っていません');
      expect(lastReply()).toContain('a=x_run');
      const [recent] = await listRecentCrosspostPosts(pool, { ownerId: f.owner, limit: 1 });
      const ig = recent!.deliveries.find((d) => d.destination === 'instagram')!;
      const gg = recent!.deliveries.find((d) => d.destination === 'google')!;
      await post({ action: 'x_drop', deliveryId: ig.id });
      expect(lastReply()).toContain('Instagram: 取りやめました（送っていません）');
      await post({ action: 'x_run', deliveryId: gg.id });
      expect(instagram.calls).toHaveLength(0);
      expect(google.calls).toHaveLength(1);
      // 取りやめた投稿先は、押し直しても送らない
      await post({ action: 'x_run', deliveryId: ig.id });
      expect(instagram.calls).toHaveLength(0);
    });

    it('承認から 24 時間を過ぎた待ちは、送らずに取りやめにする', async () => {
      const draft = await reviewingDraft();
      await publisher.approve({ ownerId: f.owner, storeId: draft.store_id, draftId: draft.id, revision: draft.revision, destinations: ['google'] });
      await pool.query(`UPDATE crosspost_drafts SET approved_at = now() - interval '25 hours' WHERE id = $1`, [draft.id]);
      await post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'google' });
      expect(google.calls).toHaveLength(0);
      expect(lastReply()).toContain('取りやめました（送っていません）');
    });

    it('投稿の実行中に止まった（実行中のまま）: 結果不明として示し、店主の確認の後だけ途中の到達点で再試行する', async () => {
      const draft = await reviewingDraft();
      await publisher.approve({ ownerId: f.owner, storeId: draft.store_id, draftId: draft.id, revision: draft.revision, destinations: ['google'] });
      // 実行権を獲得し、途中の到達点を保存したところでプロセスが止まった状態
      await pool.query(
        `UPDATE crosspost_deliveries SET status = 'in_progress', attempt_count = 1, checkpoint = 'cp-1',
                last_attempt_at = now() - interval '10 minutes' WHERE draft_id = $1`,
        [draft.id],
      );
      // 押し直しても、実行中だった投稿先は送り直さない（送ったかもしれない）
      await post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'google' });
      expect(google.calls).toHaveLength(0);
      expect(lastReply()).toContain('確認できませんでした');
      const [recent] = await listRecentCrosspostPosts(pool, { ownerId: f.owner, limit: 1 });
      const deliveryId = recent!.deliveries[0]!.id;
      await post({ action: 'x_retry', deliveryId });
      expect(google.calls).toHaveLength(0);
      await post({ action: 'x_seen', deliveryId, posted: false });
      await post({ action: 'x_retry', deliveryId });
      expect(google.calls).toHaveLength(1);
      expect(google.calls[0]!.checkpoint).toBe('cp-1');
    });
  });

  describe('同時操作', () => {
    it('「投稿する」を同時に 2 回押しても、投稿先ごとに 1 回だけ送る', async () => {
      instagram.availabilityResult = { kind: 'available' };
      const draft = await reviewingDraft();
      await Promise.all([
        post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'both' }),
        post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'both' }),
      ]);
      expect(instagram.calls).toHaveLength(1);
      expect(google.calls).toHaveLength(1);
    });

    it('「投稿する」と「やめる」が同時でも、取り消した下書きを投稿しない（どちらか一方だけが成立する）', async () => {
      const draft = await reviewingDraft();
      await Promise.all([
        post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'google' }),
        post({ action: 'x_cancel', draftId: draft.id }),
      ]);
      const status = (await pool.query<{ status: string }>('SELECT status FROM crosspost_drafts WHERE id = $1', [draft.id])).rows[0]!.status;
      if (status === 'canceled') {
        expect(google.calls).toHaveLength(0);
        expect(await deliveriesOf(draft.id)).toEqual([]);
      } else {
        expect(status).toBe('approved');
        expect(google.calls).toHaveLength(1);
      }
    });

    it('同じ投稿先の再試行・再開を同時に押しても 1 回だけ送る', async () => {
      google.behaviors = [
        async () => ({ kind: 'failed', reason: 'upstream_unavailable', retryable: true }),
        async () => ({ kind: 'succeeded', externalId: 'g-2', externalUrl: null }),
      ];
      const draft = await reviewingDraft();
      await post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'google' });
      const [recent] = await listRecentCrosspostPosts(pool, { ownerId: f.owner, limit: 1 });
      const deliveryId = recent!.deliveries[0]!.id;
      await Promise.all([post({ action: 'x_retry', deliveryId }), post({ action: 'x_retry', deliveryId })]);
      expect(google.calls).toHaveLength(2);

      // 待ちの再開と「投稿する」の押し直しが同時でも 1 回
      const second = await reviewingDraft();
      await publisher.approve({ ownerId: f.owner, storeId: second.store_id, draftId: second.id, revision: second.revision, destinations: ['google'] });
      const [queued] = await listRecentCrosspostPosts(pool, { ownerId: f.owner, limit: 1 });
      await Promise.all([
        post({ action: 'x_run', deliveryId: queued!.deliveries[0]!.id }),
        post({ action: 'x_ok', draftId: second.id, revision: second.revision, choice: 'google' }),
      ]);
      expect(google.calls).toHaveLength(3);
    });

    it('写真の差し替えと「投稿する」が同時でも、確認した写真と違う写真で投稿しない', async () => {
      const draft = await reviewingDraft(true);
      const confirmedMedia = await getCrosspostMedia(pool, { ownerId: f.owner, draftId: draft.id });
      contents.set('902', { kind: 'ok', bytes: jpeg, contentType: 'image/jpeg' });
      await Promise.all([
        post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'google' }),
        photo('902'),
      ]);
      const rows = await pool.query<{ media_id: string | null; status: string }>(
        'SELECT media_id, status FROM crosspost_deliveries WHERE draft_id = $1',
        [draft.id],
      );
      if (rows.rows.length === 0) {
        // 写真の差し替えが先: 版が進み、古い最終確認からは投稿しない
        expect(google.calls).toHaveLength(0);
      } else {
        // 承認が先: 承認した時点の写真（確認した写真）で投稿し、後から届いた写真は使わない
        expect(google.calls).toHaveLength(1);
        expect(google.calls[0]!.media?.fetchUrl).toContain(encodeURIComponent(confirmedMedia!.storage_key));
      }
    });
  });

  describe('結果の通知の失敗', () => {
    it('Reply が届かなければ Push で届け、届いたと記録する', async () => {
      const draft = await reviewingDraft();
      messenger.failReply = true;
      await post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'google' });
      expect(flatten(messenger.pushes.at(-1)?.messages ?? [])).toContain('Google: 投稿しました');
      messenger.failReply = false;
      expect(await say('こんにちは')).toBe('not_handled'); // 届いた結果は二度と出さない
    });

    it('Reply も Push も届かなければ、結果を失わず、次の操作で必ず示す', async () => {
      const draft = await reviewingDraft();
      messenger.failReply = true;
      messenger.failPush = true;
      await post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'google' });
      expect(google.calls).toHaveLength(1);
      messenger.failReply = false;
      messenger.failPush = false;
      // 投稿と関係のない文への返信でも、先に届けていない結果を示す
      expect(await say('こんにちは')).toBe('handled');
      expect(lastReply()).toContain('お届けできていなかった投稿の結果です');
      expect(lastReply()).toContain('Google: 投稿しました');
      // 一度届いたら、次の文は従来どおり（引き受けない）
      expect(await say('こんにちは')).toBe('not_handled');
    });

    it('「投稿の状況」と送れば状況を示す', async () => {
      const draft = await reviewingDraft();
      await post({ action: 'x_ok', draftId: draft.id, revision: draft.revision, choice: 'google' });
      expect(await say('投稿の状況')).toBe('handled');
      expect(lastReply()).toContain('Google: 投稿しました');
    });
  });

  describe('最終確認の写真', () => {
    it('店主が送った写真のメッセージそのものを引用して、公開する写真を示す', async () => {
      const draft = await reviewingDraft(true);
      await post({ action: 'x_conf', draftId: draft.id, revision: draft.revision, choice: 'google' });
      const [first, second] = messenger.replies.at(-1)!.messages;
      expect(first).toMatchObject({ type: 'text', quoteToken: 'qt-900' });
      expect(JSON.stringify(first)).toContain('この写真を投稿します');
      expect(JSON.stringify(second)).toContain('上で引用した写真');
    });

    it('写真を差し替えたら、最終確認は新しい写真を引用する', async () => {
      const draft = await reviewingDraft(true);
      contents.set('903', { kind: 'ok', bytes: jpeg, contentType: 'image/jpeg' });
      await photo('903');
      const replaced = (await openDraft())!;
      expect(replaced.revision).toBeGreaterThan(draft.revision);
      await post({ action: 'x_conf', draftId: draft.id, revision: replaced.revision, choice: 'google' });
      expect(messenger.replies.at(-1)!.messages[0]).toMatchObject({ quoteToken: 'qt-903' });
    });
  });
});

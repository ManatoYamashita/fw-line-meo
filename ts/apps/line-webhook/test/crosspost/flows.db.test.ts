import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
type Pool = Awaited<ReturnType<typeof getPool>>;
import { closePool, getCrosspostMedia, getOpenCrosspostDraft, getPool, listRecentCrosspostPosts } from '@fwlm/db';
import { createCrosspostFlows, type CrosspostEventBase, type CrosspostFlows } from '../../src/crosspost/flows.js';
import { createPhotoIntake } from '../../src/crosspost/intake.js';
import { encodeCrosspostPostback, type CrosspostPostback } from '../../src/crosspost/postback.js';
import { createCrosspostPublisher } from '../../src/crosspost/publisher.js';
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
  let contents: Map<string, MessageContentResult>;
  let pilot: string[];
  let jpeg: Buffer;
  let seq = 0;

  function build(): void {
    messenger = fakeMessenger();
    store = memoryMediaStore(true);
    prompts = fakePrompts();
    const logger = recordingLogger();
    const publisher = createCrosspostPublisher({ db: pool, pool, adapters: { instagram, google }, mediaStore: store, logger });
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
    flows.handleImage({ ...event(), image: { messageId, contentProvider: 'line', imageSet } });
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
});

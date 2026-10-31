import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { listOwners } from '../src/owners.js';
import type { OwnerListItem } from '../src/types.js';

// 連携状態つきのオーナー一覧（owner-line-unlink Requirement 2.1, 2.5, 2.6・Issue #487）。
// 他ファイルと DB を共有するため、衝突しない専用 UUID プレフィックス（e7）と line_user_id を使う。
const OP = 'e7000000-0000-0000-0000-000000000001';
const AG1 = 'e7000000-0000-0000-0000-000000000011';
const AG2 = 'e7000000-0000-0000-0000-000000000012';
// 連携中で、確定済み店舗 2 つ・停止中の確定済み店舗 1 つ・未確定の店舗 1 つを持つオーナー（AG1）
const OW_LINKED = 'e7000000-0000-0000-0000-000000000021';
// 解除済み・メニュー未解除で、引継ぎの無いオーナー（AG1）
const OW_PENDING = 'e7000000-0000-0000-0000-000000000022';
// 解除済み（メニュー解除済み）で、引継ぎの無いオーナー（AG1）
const OW_PLAIN = 'e7000000-0000-0000-0000-000000000023';
// 解除済みで、店舗を OW_NEW へ引き継がれたオーナー（AG1）
const OW_TAKEN = 'e7000000-0000-0000-0000-000000000024';
// OW_TAKEN の店舗を引き継いだ連携中のオーナー（AG1・招待コードの記録あり）
const OW_NEW = 'e7000000-0000-0000-0000-000000000025';
// 解除済みで、表示名を持たないオーナーへ引き継がれたオーナー（AG1）
const OW_TAKEN_NONAME = 'e7000000-0000-0000-0000-000000000026';
// OW_TAKEN_NONAME の店舗を引き継いだ、表示名を持たない連携中のオーナー（AG1）
const OW_NONAME = 'e7000000-0000-0000-0000-000000000027';
// 範囲外を見るオーナー（AG2）
const OW_OTHER = 'e7000000-0000-0000-0000-000000000028';

const ST_LINKED_FIRST = 'e7000000-0000-0000-0000-000000000031';
const ST_LINKED_SECOND = 'e7000000-0000-0000-0000-000000000032';
const ST_LINKED_PENDING = 'e7000000-0000-0000-0000-000000000033';
const ST_PENDING_OWNER = 'e7000000-0000-0000-0000-000000000034';
const ST_MOVED = 'e7000000-0000-0000-0000-000000000035';
const ST_OTHER = 'e7000000-0000-0000-0000-000000000036';
const ST_SUSPENDED = 'e7000000-0000-0000-0000-000000000037';

const LINE_LINKED = 'U-owners-list-linked';
const LINE_PENDING_MENU = 'U-owners-list-pending-menu';
const LINE_NEW = 'U-owners-list-new';
const LINE_NONAME = 'U-owners-list-noname';
const LINE_OTHER = 'U-owners-list-other';
const ALL_LINE_IDS = [LINE_LINKED, LINE_PENDING_MENU, LINE_NEW, LINE_NONAME, LINE_OTHER];

/** 一覧の 1 行が持つキーの全集合。LINE ユーザー ID を運ぶキーが紛れ込めばここで赤になる。 */
const OWNER_LIST_ITEM_KEYS = [
  'agencyId',
  'agencyName',
  'createdAt',
  'displayName',
  'id',
  'inviteCode',
  'lineLink',
  'menuUnlinkPending',
  'onboardingStatus',
  'storeNames',
  'takenOverBy',
].sort();

/** 作成日時の降順で並ぶことを確かめるため、オーナーごとに作成日時を固定する。 */
const CREATED = {
  [OW_LINKED]: '2026-07-01T00:00:00Z',
  [OW_PENDING]: '2026-07-02T00:00:00Z',
  [OW_PLAIN]: '2026-07-03T00:00:00Z',
  [OW_TAKEN]: '2026-07-04T00:00:00Z',
  [OW_NEW]: '2026-07-05T00:00:00Z',
  [OW_TAKEN_NONAME]: '2026-07-06T00:00:00Z',
  [OW_NONAME]: '2026-07-07T00:00:00Z',
  [OW_OTHER]: '2026-07-08T00:00:00Z',
} as const;

function byId(items: readonly OwnerListItem[], id: string): OwnerListItem {
  const found = items.find((item) => item.id === id);
  if (!found) throw new Error(`owner ${id} not in list`);
  return found;
}

describe.skipIf(!process.env.DATABASE_URL)('listOwners (DB)', () => {
  let inviteCodeId = '';

  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'e7運営']);
    await pool.query(
      'INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3), ($4, $2, $5)',
      [AG1, OP, 'e7代理店1', AG2, 'e7代理店2'],
    );
    const code = await pool.query<{ id: string }>(
      'INSERT INTO agency_invite_codes (agency_id, code) VALUES ($1, $2) RETURNING id',
      [AG1, 'E7LIST01'],
    );
    inviteCodeId = code.rows[0]!.id;
    // 記録には使わない 2 本目のコード。結合キーを誤ると 1 オーナーが複数行に増える（#486 と同じ網）。
    await pool.query('INSERT INTO agency_invite_codes (agency_id, code) VALUES ($1, $2)', [
      AG1,
      'E7LIST02',
    ]);
    // 連携中のオーナー（引継ぎ先を先に作る。taken_over_by_owner_id が参照するため）
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, display_name, onboarding_status, created_at,
                           invite_code_id)
       VALUES ($1, $2, $3, $4, 'store_identified', $5, NULL),
              ($6, $2, $7, $8, 'store_identified', $9, $10),
              ($11, $2, $12, NULL, 'store_identified', $13, NULL),
              ($14, $15, $16, $17, 'pending', $18, NULL)`,
      [
        OW_LINKED, AG1, LINE_LINKED, 'e7連携中', CREATED[OW_LINKED],
        OW_NEW, LINE_NEW, 'e7新担当', CREATED[OW_NEW], inviteCodeId,
        OW_NONAME, LINE_NONAME, CREATED[OW_NONAME],
        OW_OTHER, AG2, LINE_OTHER, 'e7他代理店', CREATED[OW_OTHER],
      ],
    );
    // 解除済みのオーナー（3 列の組み合わせは ck_owner_line_link・ck_owner_menu_pending・
    // ck_owner_taken_over を満たす）
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, display_name, onboarding_status, created_at,
                           line_unlinked_at, menu_pending_line_user_id, taken_over_by_owner_id)
       VALUES ($1, $2, NULL, $3, 'store_identified', $4, now(), $5, NULL),
              ($6, $2, NULL, $7, 'store_identified', $8, now(), NULL, NULL),
              ($9, $2, NULL, $10, 'store_identified', $11, now(), NULL, $12),
              ($13, $2, NULL, $14, 'store_identified', $15, now(), NULL, $16)`,
      [
        OW_PENDING, AG1, 'e7解除メニュー未解除', CREATED[OW_PENDING], LINE_PENDING_MENU,
        OW_PLAIN, 'e7解除済み', CREATED[OW_PLAIN],
        OW_TAKEN, 'e7引継ぎ済み', CREATED[OW_TAKEN], OW_NEW,
        OW_TAKEN_NONAME, 'e7無名へ引継ぎ', CREATED[OW_TAKEN_NONAME], OW_NONAME,
      ],
    );
    // 店舗: 確定済みは作成順で返り、未確定は返らない。停止中でも確定済みなら返る。
    // 挿入順と作成順を逆にして、並びが挿入順ではなく作成日時で決まることを確かめる。
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status, created_at, suspended_at)
       VALUES ($1, $2, $3, $4, 'confirmed', '2026-07-10T00:00:00Z', NULL),
              ($5, $2, $6, $7, 'confirmed', '2026-07-09T00:00:00Z', NULL),
              ($8, $9, $10, $11, 'confirmed', '2026-07-09T00:00:00Z', NULL),
              ($12, $13, $14, $15, 'confirmed', '2026-07-09T00:00:00Z', NULL),
              ($16, $17, $18, $19, 'confirmed', '2026-07-09T00:00:00Z', NULL),
              ($20, $2, $21, $22, 'confirmed', '2026-07-11T00:00:00Z', now())`,
      [
        ST_LINKED_SECOND, OW_LINKED, 'e7店舗い', 'place-e7-linked-2',
        ST_LINKED_FIRST, 'e7店舗あ', 'place-e7-linked-1',
        ST_PENDING_OWNER, OW_PENDING, 'e7メニュー未解除の店舗', 'place-e7-pending',
        ST_MOVED, OW_NEW, 'e7引き継いだ店舗', 'place-e7-moved',
        ST_OTHER, OW_OTHER, 'e7他代理店の店舗', 'place-e7-other',
        ST_SUSPENDED, 'e7停止中の店舗', 'place-e7-suspended',
      ],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_status, created_at)
       VALUES ($1, $2, $3, 'pending', '2026-07-08T00:00:00Z')`,
      [ST_LINKED_PENDING, OW_LINKED, 'e7未確定の店舗'],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('代理店を指定すると、その代理店のオーナーだけを作成日時の降順で返す（2.1）', async () => {
    const pool = await getPool();
    const ag1 = await listOwners(pool, AG1);
    expect(ag1.map((o) => o.id)).toEqual([
      OW_NONAME,
      OW_TAKEN_NONAME,
      OW_NEW,
      OW_TAKEN,
      OW_PLAIN,
      OW_PENDING,
      OW_LINKED,
    ]);
    expect(ag1.every((o) => o.agencyId === AG1 && o.agencyName === 'e7代理店1')).toBe(true);

    const ag2 = await listOwners(pool, AG2);
    expect(ag2.map((o) => o.id)).toEqual([OW_OTHER]);
    expect(ag2[0]?.agencyName).toBe('e7代理店2');
  });

  it('代理店を指定しなければ全代理店のオーナーを、担当代理店名つきの作成日時の降順で返す（2.1）', async () => {
    const pool = await getPool();
    const all = await listOwners(pool, null);
    const mine = all.filter((o) => o.agencyId === AG1 || o.agencyId === AG2);
    expect(mine.map((o) => o.id)).toEqual([
      OW_OTHER,
      OW_NONAME,
      OW_TAKEN_NONAME,
      OW_NEW,
      OW_TAKEN,
      OW_PLAIN,
      OW_PENDING,
      OW_LINKED,
    ]);
    expect(byId(all, OW_OTHER).agencyName).toBe('e7代理店2');
    expect(byId(all, OW_LINKED).agencyName).toBe('e7代理店1');
    // 全件は作成日時の降順に並ぶ
    const times = all.map((o) => o.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('連携中のオーナーは linked・メニュー未解除なし・引継ぎ先なしで、確定済み店舗の名前を作成順で返す（2.1, 2.5）', async () => {
    const pool = await getPool();
    const linked = byId(await listOwners(pool, AG1), OW_LINKED);
    expect(linked).toEqual({
      id: OW_LINKED,
      displayName: 'e7連携中',
      onboardingStatus: 'store_identified',
      createdAt: new Date(CREATED[OW_LINKED]),
      agencyId: AG1,
      agencyName: 'e7代理店1',
      lineLink: 'linked',
      menuUnlinkPending: false,
      // 未確定の店舗は含めず、停止中でも確定済みなら含める
      storeNames: ['e7店舗あ', 'e7店舗い', 'e7停止中の店舗'],
      takenOverBy: null,
      inviteCode: null,
    });
  });

  it('解除済み・メニュー未解除のオーナーは unlinked・メニュー未解除ありで返る（2.1, 2.5）', async () => {
    const pool = await getPool();
    const pending = byId(await listOwners(pool, AG1), OW_PENDING);
    expect(pending.lineLink).toBe('unlinked');
    expect(pending.menuUnlinkPending).toBe(true);
    expect(pending.storeNames).toEqual(['e7メニュー未解除の店舗']);
    expect(pending.takenOverBy).toBeNull();
  });

  it('解除済み（メニュー解除済み）のオーナーは unlinked・メニュー未解除なしで、店舗が無ければ空配列（2.1, 2.5）', async () => {
    const pool = await getPool();
    const plain = byId(await listOwners(pool, AG1), OW_PLAIN);
    expect(plain.lineLink).toBe('unlinked');
    expect(plain.menuUnlinkPending).toBe(false);
    expect(plain.storeNames).toEqual([]);
    expect(plain.takenOverBy).toBeNull();
  });

  it('店舗を引き継がれたオーナーは引継ぎ先のオーナー ID と表示名を返す（2.6）', async () => {
    const pool = await getPool();
    const items = await listOwners(pool, AG1);
    const taken = byId(items, OW_TAKEN);
    expect(taken.lineLink).toBe('unlinked');
    expect(taken.menuUnlinkPending).toBe(false);
    expect(taken.storeNames).toEqual([]);
    expect(taken.takenOverBy).toEqual({ ownerId: OW_NEW, displayName: 'e7新担当' });

    // 引継ぎ先が表示名を持たなければ displayName は null
    expect(byId(items, OW_TAKEN_NONAME).takenOverBy).toEqual({
      ownerId: OW_NONAME,
      displayName: null,
    });

    // 引き継いだ側は連携中で、引き継いだ店舗を自分の店舗として返す
    const taker = byId(items, OW_NEW);
    expect(taker.lineLink).toBe('linked');
    expect(taker.storeNames).toEqual(['e7引き継いだ店舗']);
    expect(taker.takenOverBy).toBeNull();
  });

  it('登録に用いた招待コードの記録を { id, code, disabled } の形で返す（agency-dashboard Req 8.5 の維持）', async () => {
    const pool = await getPool();
    const items = await listOwners(pool, AG1);
    expect(byId(items, OW_NEW).inviteCode).toEqual({
      id: inviteCodeId,
      code: 'E7LIST01',
      disabled: false,
    });
    expect(byId(items, OW_LINKED).inviteCode).toBeNull();
  });

  it('どの行も LINE ユーザー ID を運ぶキーや値を持たない（2.1）', async () => {
    const pool = await getPool();
    const all = await listOwners(pool, null);
    const mine = all.filter((o) => o.agencyId === AG1 || o.agencyId === AG2);
    expect(mine).toHaveLength(8);
    for (const item of mine) {
      expect(Object.keys(item).sort()).toEqual(OWNER_LIST_ITEM_KEYS);
      if (item.takenOverBy !== null) {
        expect(Object.keys(item.takenOverBy).sort()).toEqual(['displayName', 'ownerId']);
      }
    }
    const serialized = JSON.stringify(mine);
    for (const lineUserId of ALL_LINE_IDS) {
      expect(serialized).not.toContain(lineUserId);
    }
  });
});

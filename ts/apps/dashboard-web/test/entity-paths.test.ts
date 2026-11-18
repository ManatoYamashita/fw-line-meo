import { describe, expect, it } from 'vitest';
import { agencyPath, ownerPath, storePath, toEntityId } from '../src/lib/entity-paths';

// 詳細の画面の経路と、経路の値の正規化（agency-dashboard Requirement 10.1–10.3・11.9・Issue #526・tasks 9.3）。
// toEntityId は代理店詳細の toAgencyId（Issue #486・Req 9.6）をここへ移したもの。

// 英字を含める。数字だけの id は toUpperCase() で値が変わらず、大小の扱いの試験が空振りする。
const ID = 'abcdef22-2222-2222-2222-222222222222';

describe('toEntityId', () => {
  const MIXED = 'AbCdEf00-1111-2222-3333-444455556666';

  it('UUID の形なら小文字へ正規化して返す（大小を問わず同じ行を指す）', () => {
    expect(toEntityId(ID)).toBe(ID);
    expect(toEntityId(ID.toUpperCase())).toBe(ID);
    expect(toEntityId(MIXED)).toBe(MIXED.toLowerCase());
  });

  it('UUID の形でない値は null（API を呼ばずに「見つかりません」へ回す・11.9）', () => {
    for (const value of ['', 'abc', 'new', `${ID}x`, ` ${ID}`, ID.replaceAll('-', ''), '../stores']) {
      expect(toEntityId(value), value).toBeNull();
    }
  });
});

describe('詳細の経路', () => {
  it('店舗・オーナー・代理店の詳細の経路を組み立てる（10.1–10.3）', () => {
    expect(storePath(ID)).toBe(`/stores/${ID}`);
    expect(ownerPath(ID)).toBe(`/owners/${ID}`);
    expect(agencyPath(ID)).toBe(`/admin/agencies/${ID}`);
  });

  it('経路の区切りを含む値は 1 つの段に閉じ込める（別の経路へ化けない）', () => {
    expect(storePath('a/b')).toBe('/stores/a%2Fb');
    expect(ownerPath('../x')).toBe('/owners/..%2Fx');
  });
});

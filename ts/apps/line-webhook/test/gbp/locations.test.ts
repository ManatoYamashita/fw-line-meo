import { describe, it, expect } from 'vitest';
import type { GbpAccountLocation, GbpApiError } from '../../src/gbp/client.js';
import {
  findLocationForPlace,
  matchLocationByPlaceId,
  type LocationLookupClient,
} from '../../src/gbp/locations.js';

// gbp-post-review-reply spec task 3.1（GbpLocations）の unit テスト。
// Requirements: 1.6（管理権限を持たないアカウントでは連携を成立させない）。
// 実ネットワークには一切触れない（GbpClient をスタブ注入する）。

const PLACE_ID = 'ChIJfc0000000000000000000000';
const OTHER_PLACE_ID = 'ChIJfc9999999999999999999999';
const ACCESS_TOKEN = 'ya29.locations-test-access-token';

function location(overrides: Partial<GbpAccountLocation> = {}): GbpAccountLocation {
  return {
    accountName: 'accounts/111',
    locationName: 'locations/222',
    title: 'テスト店舗',
    placeId: PLACE_ID,
    canOperateLocalPost: true,
    ...overrides,
  };
}

/** listAccountsAndLocations の応答を固定するスタブ（呼び出し引数を記録）。 */
function stubClient(
  result:
    | { ok: true; value: GbpAccountLocation[] }
    | { ok: false; error: GbpApiError },
): LocationLookupClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listAccountsAndLocations(accessToken: string) {
      calls.push(accessToken);
      return result;
    },
  };
}

describe('matchLocationByPlaceId', () => {
  it('placeId が一致する location を返す', () => {
    const target = location({ locationName: 'locations/hit' });
    const matched = matchLocationByPlaceId(
      [location({ placeId: OTHER_PLACE_ID, locationName: 'locations/miss' }), target],
      PLACE_ID,
    );
    expect(matched).toEqual(target);
  });

  it('一致しない場合は null（管理権限なしの判定材料）', () => {
    expect(matchLocationByPlaceId([location({ placeId: OTHER_PLACE_ID })], PLACE_ID)).toBeNull();
  });

  it('placeId 未設定（null）の location は一致させない', () => {
    expect(matchLocationByPlaceId([location({ placeId: null })], PLACE_ID)).toBeNull();
  });

  it('空文字・空白のみの placeId は誰とも一致させない（誤連携の防止）', () => {
    expect(matchLocationByPlaceId([location({ placeId: '' })], '')).toBeNull();
    expect(matchLocationByPlaceId([location({ placeId: '   ' })], '   ')).toBeNull();
  });

  it('placeId は前後の空白を無視して厳密一致で比較する（大小文字は区別する）', () => {
    expect(matchLocationByPlaceId([location({ placeId: ` ${PLACE_ID} ` })], PLACE_ID)).not.toBeNull();
    expect(matchLocationByPlaceId([location({ placeId: PLACE_ID.toLowerCase() })], PLACE_ID)).toBeNull();
  });

  it('複数一致時は投稿可能な location を優先する', () => {
    const postable = location({ locationName: 'locations/postable', canOperateLocalPost: true });
    const matched = matchLocationByPlaceId(
      [location({ locationName: 'locations/readonly', canOperateLocalPost: false }), postable],
      PLACE_ID,
    );
    expect(matched?.locationName).toBe('locations/postable');
  });

  // 全件が投稿不可でも「一致は一致」として連携は成立させる（クチコミ返信は使えるため）。
  // 投稿だけを断る判定は GbpFlows の beginPostForStore が gbp_locations の
  // can_operate_local_post を読んで行う（PR #121 レビュー指摘）。
  it('全件 canOperateLocalPost が false でも先頭を返す（連携自体は成立させる）', () => {
    const first = location({ locationName: 'locations/a', canOperateLocalPost: false });
    const matched = matchLocationByPlaceId(
      [first, location({ locationName: 'locations/b', canOperateLocalPost: false })],
      PLACE_ID,
    );
    expect(matched).toEqual(first);
  });
});

describe('findLocationForPlace', () => {
  it('一致する location があれば matched を返す', async () => {
    const client = stubClient({ ok: true, value: [location()] });
    const res = await findLocationForPlace(client, { accessToken: ACCESS_TOKEN, placeId: PLACE_ID });
    expect(res).toEqual({ kind: 'matched', location: location() });
    expect(client.calls).toEqual([ACCESS_TOKEN]);
  });

  it('列挙は成功したが一致なし = 管理権限なし（Req 1.6）', async () => {
    const client = stubClient({ ok: true, value: [location({ placeId: OTHER_PLACE_ID })] });
    const res = await findLocationForPlace(client, { accessToken: ACCESS_TOKEN, placeId: PLACE_ID });
    expect(res).toEqual({ kind: 'no_permission' });
  });

  it('列挙が空でも管理権限なしと判定する', async () => {
    const client = stubClient({ ok: true, value: [] });
    const res = await findLocationForPlace(client, { accessToken: ACCESS_TOKEN, placeId: PLACE_ID });
    expect(res).toEqual({ kind: 'no_permission' });
  });

  it('incomplete_listing は no_permission にせず再試行対象の error にする（1.6 の誤判定防止）', async () => {
    const client = stubClient({ ok: false, error: { kind: 'incomplete_listing' } });
    const res = await findLocationForPlace(client, { accessToken: ACCESS_TOKEN, placeId: PLACE_ID });
    expect(res).toEqual({ kind: 'error', reason: 'listing_incomplete' });
  });

  it('その他の API 失敗も no_permission にせず error にする', async () => {
    for (const error of [
      { kind: 'permission_denied' } as const,
      { kind: 'rate_limited' } as const,
      { kind: 'upstream_error', status: 503 } as const,
    ]) {
      const client = stubClient({ ok: false, error });
      const res = await findLocationForPlace(client, {
        accessToken: ACCESS_TOKEN,
        placeId: PLACE_ID,
      });
      expect(res).toEqual({ kind: 'error', reason: 'listing_failed' });
    }
  });

  it('placeId が空なら列挙せず error（照合対象が無い状態で連携を成立させない）', async () => {
    const client = stubClient({ ok: true, value: [location({ placeId: '' })] });
    const res = await findLocationForPlace(client, { accessToken: ACCESS_TOKEN, placeId: '  ' });
    expect(res).toEqual({ kind: 'error', reason: 'invalid_place_id' });
    expect(client.calls).toEqual([]);
  });
});

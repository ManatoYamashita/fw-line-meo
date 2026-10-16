import { expect, type Page, type Route } from '@playwright/test';

import { STORE_ID, STORE_NAME } from './detail';

// アンケート設定画面（Issue #437）の E2E の固定データと、面を開く手順。
//
// 詳細画面の fixture（detail.ts）と同じく DB を起こさず、page.route() で API を供給する。ここでは設定を
// 変える操作を確かめるので、固定の応答ではなく **メモリ上の設定を書き換える偽の API** を置く。偽の API は
// 契約（lib/survey-settings-contract.ts の応答の形とパス）だけを真似る。重複・上限などの判定の本物は
// サーバーの DB テスト（store-detail/test/survey-settings-api.db.test.ts）が確かめる。
//
// 名前は面を最も横へ広げる値を意図的に混ぜる（40 文字ちょうどの名前）。横スクロールの検証は最悪ケースで
// 溢れないことを測るものであり、短い名前だけで緑になっても何も担保しない。

interface Target {
  id: string;
  categoryCode: string;
  label: string;
  active: boolean;
  sortOrder: number;
}

interface Category {
  readonly code: string;
  readonly label: string;
  readonly allowsTargets: boolean;
  enabled: boolean;
  readonly toggleable: boolean;
  readonly ownerTargets: boolean;
  readonly targetLimit: number | null;
}

/** 40 文字ちょうどの料理名（入力規則の上限）。 */
export const LONGEST_LABEL = '旬の朝獲れ鮮魚を使った特製刺身盛り合わせ五種と季節の小鉢、自家製ポン酢添え付き。';

function initialState() {
  const categories: Category[] = [
    { code: 'food', label: '料理', allowsTargets: true, enabled: true, toggleable: false, ownerTargets: true, targetLimit: 10 },
    { code: 'drink', label: 'ドリンク', allowsTargets: true, enabled: true, toggleable: false, ownerTargets: true, targetLimit: 10 },
    { code: 'service_delivery', label: '接客・提供', allowsTargets: false, enabled: true, toggleable: false, ownerTargets: false, targetLimit: null },
    { code: 'atmosphere', label: '店内・雰囲気', allowsTargets: false, enabled: true, toggleable: false, ownerTargets: false, targetLimit: null },
    { code: 'price', label: '価格', allowsTargets: false, enabled: true, toggleable: false, ownerTargets: false, targetLimit: null },
    { code: 'reservation_visit', label: '予約・来店', allowsTargets: false, enabled: true, toggleable: true, ownerTargets: false, targetLimit: null },
  ];
  const targets: Target[] = [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', categoryCode: 'food', label: LONGEST_LABEL, active: true, sortOrder: 0 },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', categoryCode: 'food', label: '焼き鳥5種盛り', active: true, sortOrder: 1 },
    { id: 'aaaaaaaa-0000-4000-8000-000000000003', categoryCode: 'food', label: '名物もつ煮', active: false, sortOrder: 0 },
    { id: 'aaaaaaaa-0000-4000-8000-000000000004', categoryCode: 'drink', label: '自家製レモンサワー', active: true, sortOrder: 0 },
  ];
  return { revision: 1, categories, targets };
}

export interface FakeSurveySettingsApi {
  /** 受けた要求（メソッドとパス）。 */
  readonly requests: { method: string; path: string }[];
  /** 表示中の料理名を並び順で返す。 */
  activeLabels(categoryCode: string): string[];
}

const API_GLOB = '**/api/survey-settings**';

/** メモリ上の設定を書き換える偽の API を置く。 */
export async function stubSurveySettingsApi(page: Page): Promise<FakeSurveySettingsApi> {
  const state = initialState();
  const requests: { method: string; path: string }[] = [];
  let seq = 100;

  const body = () => ({
    storeId: STORE_ID,
    storeName: STORE_NAME,
    stores: [{ storeId: STORE_ID, name: STORE_NAME }],
    structuredEnabled: false,
    revision: state.revision,
    categories: state.categories,
    targets: [...state.targets].sort(
      (a, b) =>
        a.categoryCode.localeCompare(b.categoryCode) ||
        Number(b.active) - Number(a.active) ||
        a.sortOrder - b.sortOrder,
    ),
  });
  const active = (code: string) =>
    state.targets.filter((t) => t.categoryCode === code && t.active).sort((a, b) => a.sortOrder - b.sortOrder);
  const ok = (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body()) });
  const fail = (route: Route, status: number, code: string, message: string) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code, message } }) });

  await page.route(API_GLOB, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    requests.push({ method, path });
    const json = (request.postData() ? JSON.parse(request.postData()!) : {}) as Record<string, unknown>;
    const parts = path.split('/').filter(Boolean); // ['api', 'survey-settings', ...]

    if (method === 'GET' && parts.length === 2) return ok(route);
    if (method === 'POST' && parts[2] === 'targets' && parts.length === 3) {
      const label = String(json.label).trim();
      const code = String(json.categoryCode);
      if (active(code).some((t) => t.label === label)) {
        return fail(route, 409, 'DUPLICATE_LABEL', '同じ名前がすでに表示されています。別の名前にしてください。');
      }
      const hidden = state.targets.find((t) => t.categoryCode === code && !t.active && t.label === label);
      const sortOrder = active(code).length;
      if (hidden) Object.assign(hidden, { active: true, sortOrder });
      else state.targets.push({ id: `aaaaaaaa-0000-4000-8000-000000000${seq++}`, categoryCode: code, label, active: true, sortOrder });
      state.revision += 1;
      return ok(route);
    }
    if (method === 'PUT' && parts[3] === 'order') {
      const ids = json.targetIds as string[];
      ids.forEach((id, index) => {
        const target = state.targets.find((t) => t.id === id);
        if (target) target.sortOrder = index;
      });
      state.revision += 1;
      return ok(route);
    }
    if (parts[2] === 'targets' && parts[3]) {
      const target = state.targets.find((t) => t.id === parts[3]);
      if (!target) return fail(route, 404, 'TARGET_NOT_FOUND', '項目が見つかりません。画面を開き直してください。');
      if (method === 'POST' && parts[4] === 'disable') target.active = false;
      else if (method === 'PATCH') {
        if (typeof json.label === 'string') target.label = json.label.trim();
        if (json.active === true && !target.active) Object.assign(target, { active: true, sortOrder: active(target.categoryCode).length });
      }
      state.revision += 1;
      return ok(route);
    }
    if (method === 'PATCH' && parts[2] === 'categories') {
      const category = state.categories.find((c) => c.code === parts[3]);
      if (category) category.enabled = json.enabled === true;
      state.revision += 1;
      return ok(route);
    }
    return fail(route, 400, 'INVALID_BODY', '送信内容を読み取れませんでした。');
  });

  return {
    requests,
    activeLabels: (code) => active(code).map((t) => t.label),
  };
}

/**
 * 設定画面を開き、エラー画面ではなく本体（料理・ドリンク・予約・来店の節）を描けていることを固定してから返す。
 * 空の画面には違反も溢れも出ようがないので、測る前に必ずこの前提を通す（detail.ts の openStoreSurface と同じ考え方）。
 */
export async function openSurveySettingsSurface(page: Page): Promise<FakeSurveySettingsApi> {
  const api = await stubSurveySettingsApi(page);
  await page.goto(`/store/survey-settings?storeId=${STORE_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'アンケート設定' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: '料理' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'ドリンク' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: '予約・来店' })).toBeVisible();
  await expect(page.getByText(LONGEST_LABEL)).toBeVisible();
  expect(api.requests).toEqual([{ method: 'GET', path: '/api/survey-settings' }]);
  return api;
}

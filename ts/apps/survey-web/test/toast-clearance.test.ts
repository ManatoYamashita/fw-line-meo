// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { liftNeeded, settledToastTop, TOAST_CLEARANCE_GAP } from '../src/lib/toast-clearance';

// Sonner 2 の DOM を最小の形で組む。jsdom は配置を計算しないので、矩形と高さは差し込む。
function toaster(bottom: number, toasts: { height: number; offset: number; removed?: boolean; visible?: boolean }[], y = 'bottom'): HTMLElement {
  const ol = document.createElement('ol');
  ol.setAttribute('data-sonner-toaster', 'true');
  ol.setAttribute('data-y-position', y);
  ol.getBoundingClientRect = () => ({ bottom, top: bottom, left: 0, right: 0, width: 0, height: 0, x: 0, y: bottom, toJSON: () => ({}) });
  for (const t of toasts) {
    const li = document.createElement('li');
    li.setAttribute('data-sonner-toast', '');
    li.dataset.removed = String(t.removed ?? false);
    li.dataset.visible = String(t.visible ?? true);
    li.style.setProperty('--offset', `${t.offset}px`);
    Object.defineProperty(li, 'offsetHeight', { value: t.height });
    ol.append(li);
  }
  document.body.append(ol);
  return ol;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('settledToastTop: Toast が落ち着いたときの上端', () => {
  it('Toast が無ければ null', () => {
    toaster(552, []);
    expect(settledToastTop(document)).toBeNull();
  });

  it('1 件なら Toaster の下端から自分の高さを引いた位置（登場中の transform に左右されない）', () => {
    toaster(552, [{ height: 92, offset: 0 }]);
    expect(settledToastTop(document)).toBe(460);
  });

  it('積み重なっていれば、積み重ねの量（--offset）も引いたいちばん上の位置', () => {
    toaster(552, [{ height: 60, offset: 0 }, { height: 92, offset: 74 }]);
    expect(settledToastTop(document)).toBe(552 - 74 - 92);
  });

  it('消えつつある Toast・隠れている Toast・上側の Toaster は数えない', () => {
    toaster(552, [{ height: 92, offset: 0 }, { height: 200, offset: 106, removed: true }, { height: 200, offset: 106, visible: false }]);
    toaster(100, [{ height: 90, offset: 0 }], 'top');
    expect(settledToastTop(document)).toBe(460);
  });
});

describe('liftNeeded: 操作の並びを Toast の上へ送る量', () => {
  it('Toast が無い・重ならないときは送らない', () => {
    expect(liftNeeded(620, null)).toBe(0);
    expect(liftNeeded(620, 755)).toBe(0);
    expect(liftNeeded(620, 620 + TOAST_CLEARANCE_GAP)).toBe(0);
  });

  it('重なるときは、並びの下端が Toast の上端より隙間ぶん上へ来るだけ送る', () => {
    // 320×568 の実測: 並びの下端 620・Toast の上端 460
    expect(liftNeeded(620, 460)).toBe(620 + TOAST_CLEARANCE_GAP - 460);
    expect(liftNeeded(620.4, 578)).toBe(55);
  });
});

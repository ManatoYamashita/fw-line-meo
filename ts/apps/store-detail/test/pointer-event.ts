// jsdom に PointerEvent の互換実装を入れるテスト専用ヘルパー（store-detail-trend-dashboard task 3.2・
// Issue #265）。
//
// jsdom 25 は PointerEvent を実装していない。一方、Base UI の Radio（`@fwlm/ui` の RadioGroupItem）は、
// 印のクリックを隠し input へ `new PointerEvent('click')` で転送する（RadioRoot の onClick）。互換実装が
// 無いと、印のクリックは例外になり、選択状態が移らない。実ブラウザには必ずある API なので、テスト環境の
// 欠落だけを補う。部品の振る舞いは書き換えない。
//
// 実装は `ts/packages/ui/test/components.test.tsx` のものと同じである。店舗詳細では、選択肢の部品の
// テスト（test/trend-controls.test.tsx）と、タスク 4.1 以降のページ全体のテストの両方が使うので、ここに
// 1 つだけ置く（前例は test/live-region.ts）。vitest の既定の include に載らないので、単体では実行されない。
//
// jsdom の環境（`// @vitest-environment jsdom`）で、描画より前に呼ぶこと。すでに PointerEvent がある
// 環境では何もしない。

/**
 * window に PointerEvent が無ければ、MouseEvent を継承した最小の互換実装を入れる。何度呼んでもよい。
 */
export function installPointerEventPolyfill(): void {
  if ('PointerEvent' in window) {
    return;
  }
  class PointerEventPolyfill extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', {
    value: PointerEventPolyfill,
    configurable: true,
    writable: true,
  });
}

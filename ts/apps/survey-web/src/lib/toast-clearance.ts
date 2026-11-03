// コピーの結果を知らせる Toast が、下書きパネルの操作（とくに「Google のクチコミ欄を開く」）を
// 覆わないようにする（PR #470）。
//
// Toast の置き場は全画面で右下に固定する（design-language 7.5）。狭い画面（320×568 など）では、
// コピーの直後に出る Toast が、次に押すリンクの上に 6 秒間かぶさり、押せなくなっていた。
// 共通の Toaster の位置や表示時間は変えず、この面の側で、操作の並びが Toast より上に来るよう
// 画面を少しだけ送る。
//
// Toast の最終的な位置は Sonner 2 の DOM から読む。Toast は Toaster（`[data-sonner-toaster]`・
// 下端が固定）の中で下端に揃い、Sonner が積み重ねの量を各 Toast の `--offset` に書く。登場中は
// transform で下から滑り込むので、見た目の矩形ではなく「Toaster の下端 − 積み重ね − 自分の高さ」で
// 落ち着き先を求める。Sonner の DOM の契約が変わったときは E2E（action-feedback.spec.ts）が落ちる。

/** 操作の並びの下端と、Toast の上端との間に空ける隙間（px）。 */
export const TOAST_CLEARANCE_GAP = 12;

/**
 * 表示中の Toast がすべて落ち着いたときの、いちばん上の Toast の上端（ビューポート座標）。
 * 表示中の Toast が無ければ null。下側に出る Toaster だけを見る。
 */
export function settledToastTop(doc: Document): number | null {
  let top: number | null = null;
  for (const toaster of doc.querySelectorAll<HTMLElement>('[data-sonner-toaster][data-y-position="bottom"]')) {
    const bottom = toaster.getBoundingClientRect().bottom;
    for (const toast of toaster.querySelectorAll<HTMLElement>('[data-sonner-toast]')) {
      if (toast.dataset.removed === 'true' || toast.dataset.visible === 'false') continue;
      const offset = Number.parseFloat(toast.style.getPropertyValue('--offset')) || 0;
      const edge = bottom - offset - toast.offsetHeight;
      top = top === null ? edge : Math.min(top, edge);
    }
  }
  return top;
}

/** 操作の並びの下端を Toast の上端より `gap` だけ上へ送るのに要る量（px）。送らなくてよければ 0。 */
export function liftNeeded(actionsBottom: number, toastTop: number | null, gap = TOAST_CLEARANCE_GAP): number {
  if (toastTop === null) return 0;
  return Math.max(0, Math.ceil(actionsBottom + gap - toastTop));
}

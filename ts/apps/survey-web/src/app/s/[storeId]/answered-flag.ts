// 回答済みフラグ（クライアント localStorage のみ・24 時間）。
// サーバーは端末を識別しない（個人特定手段を用いない・Req 2.10）。消去すれば再回答可能（匿名性優先）。

const PREFIX = 'fwlm:answered:';
const WINDOW_MS = 24 * 60 * 60 * 1000;

function key(storeId: string): string {
  return `${PREFIX}${storeId}`;
}

export function markAnswered(storeId: string, now: number = Date.now()): void {
  try {
    localStorage.setItem(key(storeId), String(now));
  } catch {
    // localStorage 不可（プライベートモード等）は無視。
  }
}

export function isRecentlyAnswered(storeId: string, now: number = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(key(storeId));
    if (!raw) return false;
    const at = Number(raw);
    const elapsed = now - at;
    return Number.isFinite(at) && elapsed >= 0 && elapsed < WINDOW_MS;
  } catch {
    return false;
  }
}

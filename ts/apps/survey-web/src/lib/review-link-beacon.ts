// 投稿導線の押下の通知（client util・Issue #137・Requirement 5.7 / 5.8）。
//
// 投稿リンクは Google の投稿画面への直リンクのまま残し、押下の観測はこの通知で遷移と独立に行う。
// 自サーバーを経由するリダイレクトにしないのは、自サーバーの障害が投稿そのものを塞ぎ、
// Requirement 3.9・4.4 の「投稿導線は失敗時も維持する」に反するためである。
//
// 通知は投げっぱなしで、結果を待たない。どんな環境でも例外を外へ出さない（リンクの onClick から
// 例外が漏れると遷移を妨げうる）。サーバーは token を検証できた押下だけを数える
// （`app/api/review-link-opened/handler.ts`）。

export const REVIEW_LINK_OPENED_PATH = '/api/review-link-opened';

/**
 * 押下をサーバーへ知らせる。token は下書き画面なら sessionToken、回答済み画面なら pageToken。
 *
 * sendBeacon を優先する。ページが遷移・非表示になっても送達され、応答を待たないためである。
 * 使えない、または受け付けなかった（送信キューが満杯など）ときは keepalive の fetch へ落とす。
 */
export function notifyReviewLinkOpened(storeId: string, token: string): void {
  const body = JSON.stringify({ storeId, token });
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      if (navigator.sendBeacon(REVIEW_LINK_OPENED_PATH, body)) return;
    }
    fetch(REVIEW_LINK_OPENED_PATH, { method: 'POST', body, keepalive: true }).catch(() => {
      // swallowed-exception: intentional — 通知の送達失敗で投稿導線を妨げない（Requirement 5.8）。
      // 観測の欠けは押下件数を下限として読む前提で吸収する（design.md の ReviewLinkAPI）。
    });
  } catch {
    // swallowed-exception: intentional — sendBeacon や fetch が同期的に投げても、リンクの遷移を妨げない
    // （Requirement 5.8）。客へ見せる失敗ではなく、記録する先も無い（客の端末のコンソールは誰も読まない）。
  }
}

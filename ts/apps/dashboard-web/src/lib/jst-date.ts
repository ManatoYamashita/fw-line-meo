// 時刻（ISO 8601）を日本時間の暦日（YYYY-MM-DD）へ整形する（Issue #485）。
//
// 一覧の作成日のように、利用者が読む日付だけを出す。ブラウザの TZ に委ねると、日本国外の端末や
// TZ を UTC に固定した実行環境で日付が 1 日ずれるので、固定の +09:00 を足して UTC の getter で読む。
// 固定値と整形方式は scripts/check-jst-offset-consistency.sh が機械強制する（Issue #299）。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 解釈できない値は null を返す（呼び出し側が「不明」と出し分ける）。 */
export function formatJstDate(iso: string): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Date(time + JST_OFFSET_MS).toISOString().slice(0, 10);
}

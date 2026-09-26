// 流量制限の鍵（送信元 IP）を X-Forwarded-For から取り出す（Issue #344）。
//
// 先頭の値は客が自由に書ける。Google の前段は、客が送ってきた値を検証せずに残し、その後ろへ
// 本物の値を付け足すためである。先頭を鍵にすると、客は毎回違う値を送るだけで流量制限をすり抜けられた
// （2026-09-26 に本番で実測）。したがって鍵は、客が書けない**後ろ側**から取る。
//
// アプリに届く並びは経路で変わる（2026-09-26 に本番で実測。Issue #344 のコメント）:
//   run.app 直:            <客の送った値…>, <送信元 IP>
//   ロードバランサ経由:    <客の送った値…>, <送信元 IP>, <ロードバランサの IP>
//
// 末尾が信頼する前段（ロードバランサ）の IP なら 1 つ手前を、そうでなければ末尾を鍵にする。
// run.app 直で客がロードバランサの IP を末尾に偽っても、その後ろへ Google が本物の送信元 IP を
// 付けるので、末尾がロードバランサの IP になることはない。
//
// 信頼する前段の IP は env `SURVEY_TRUSTED_PROXY_IPS`（カンマ区切り）で渡す（tf が
// ロードバランサの外部 IP を注入する）。**未設定だとロードバランサ経由の客全員がロードバランサの
// IP という 1 つの鍵を分け合う**ので、env は必ずイメージより先に入れること（infra/README.md §9-2-d）。

/** env の値を信頼する前段の IP の一覧にする。空の要素は捨てる。 */
export function parseTrustedProxyIps(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((ip) => ip.trim())
    .filter((ip) => ip.length > 0);
}

/** X-Forwarded-For から流量制限の鍵を取り出す。取り出せなければ 'unknown'。 */
export function clientKeyFromForwardedFor(
  forwardedFor: string | null,
  trustedProxyIps: readonly string[],
): string {
  if (forwardedFor === null) return 'unknown';
  const parts = forwardedFor
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const last = parts.at(-1);
  if (last === undefined) return 'unknown';
  if (!trustedProxyIps.includes(last)) return last;
  return parts.at(-2) ?? 'unknown';
}

/** 3 つの API が共有する鍵の取り出し。env は呼ぶたびに読まず、最初の 1 回で固定する。 */
export function createClientKey(
  trustedProxyIps: readonly string[] = parseTrustedProxyIps(process.env.SURVEY_TRUSTED_PROXY_IPS),
): (req: Request) => string {
  return (req) => clientKeyFromForwardedFor(req.headers.get('x-forwarded-for'), trustedProxyIps);
}

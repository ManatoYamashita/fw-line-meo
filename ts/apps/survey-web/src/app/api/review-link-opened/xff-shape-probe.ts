import { createHash } from 'node:crypto';

// 一時的な計測（Issue #344）。流量制限の鍵を X-Forwarded-For のどの位置から取るかを決めるため、
// run.app 直とロードバランサ経由の 2 経路で、アプリに届く要素の並びを測る。鍵の修正と同時に削除する。
//
// 運営が送る目印の値を含む要求にだけ応答ヘッダで並びを返す。来店客の要求では何もしない。
// ログには何も書かない。値は目印を除いてハッシュの先頭 8 文字にし、IP そのものは返さない。
// 目印は文書用アドレス（RFC 5737）で、実在の客が送ることはない。

export const XFF_PROBE_MARKER = '203.0.113.99';
export const XFF_SHAPE_HEADER = 'X-Xff-Shape';

function tag(value: string): string {
  if (value === XFF_PROBE_MARKER) return 'probe';
  return createHash('sha256').update(`xff-shape-344:${value}`).digest('hex').slice(0, 8);
}

/** 目印を含む要求なら `probe,1a2b3c4d,...` の形の並びを返す。含まなければ null。 */
export function xffShape(req: Request): string | null {
  const raw = req.headers.get('x-forwarded-for');
  if (raw === null) return null;
  const parts = raw.split(',').map((p) => p.trim());
  if (!parts.includes(XFF_PROBE_MARKER)) return null;
  return parts.map(tag).join(',');
}

/** 並びがあれば応答ヘッダへ載せる。無ければ応答をそのまま返す。 */
export function withXffShape(req: Request, res: Response): Response {
  const shape = xffShape(req);
  if (shape === null) return res;
  const headers = new Headers(res.headers);
  headers.set(XFF_SHAPE_HEADER, shape);
  return new Response(res.body, { status: res.status, headers });
}

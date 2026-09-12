// API 共通のレスポンスヘルパ。エラーは { error: { code, message } } 封筒で統一する。

export function jsonError(status: number, code: string, message: string, supportCode?: string): Response {
  return new Response(JSON.stringify({ error: { code, message }, ...(supportCode ? { supportCode } : {}) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

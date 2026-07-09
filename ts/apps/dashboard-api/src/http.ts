// エラー封筒 { error: { code, message } } を統一（survey-web と同形）。
export function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

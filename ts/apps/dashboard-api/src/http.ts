// エラー封筒 { error: { code, message } } を統一（survey-web と同形）。
export function jsonError(status: number, code: string, message: string, supportCode?: string): Response {
  return new Response(JSON.stringify({ error: { code, message }, ...(supportCode ? { supportCode } : {}) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

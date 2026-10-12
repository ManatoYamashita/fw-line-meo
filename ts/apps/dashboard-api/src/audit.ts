import type { AuditLogger, AuditLogInput } from '@fwlm/db';
import type { Sink } from '@fwlm/observability';

// 監査記録（audit_logs）を業務の書込の後に書く（Issue #250・案 A）。
//
// 監査の INSERT が失敗しても、確定済みの業務の書込をエラー応答へ変えない。業務の書込は別の接続で
// 既に確定しているので、エラーを返すと「書込は成功・監査は欠ける・応答はエラー」になり、押し直した
// 利用者が代理店や招待コードを重複して作る。失敗は警告として記録し、応答は業務の結果どおりに返す。
// line-webhook の tryAuditLog（src/owner/completed-menu.ts）と同じ規則である。
//
// 払うもの: その操作の監査記録が欠ける。欠けた記録を人手で補えるよう、警告に action と対象の
// 識別子を載せる（どちらも個人情報ではない。来店客は監査の対象にならない）。警告は 30 日で消える。

/** 例外の種別だけを取り出す。本文は記録しない（接続情報や入力値が混ざりうるため）。 */
function errorKindOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'UnknownError';
}

/** 監査記録を書く。失敗は握って警告を残し、呼び出し元へ例外を返さない。 */
export async function recordAudit(
  auditLog: AuditLogger,
  log: Sink | undefined,
  input: AuditLogInput,
): Promise<void> {
  try {
    await auditLog(input);
  } catch (err) {
    log?.('warn', 'dashboard-api.audit_log_failed', {
      errorKind: errorKindOf(err),
      auditAction: input.action,
      auditTargetId: input.targetId,
    });
  }
}

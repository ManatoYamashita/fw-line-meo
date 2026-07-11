// 明示的な成功/失敗を表す判別可能ユニオン（例外に頼らず型で分岐する）。
// SessionToken(3.2)・DraftGenerator(3.6) 等が共有する。
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

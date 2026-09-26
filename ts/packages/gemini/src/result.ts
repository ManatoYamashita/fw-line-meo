// 明示的な成功/失敗を表す判別可能ユニオン（例外に頼らず型で分岐する）。
// 本パッケージ自前の定義（packages/db・survey-web の同形定義とは統合しない。三重化はここで打ち止め）。
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

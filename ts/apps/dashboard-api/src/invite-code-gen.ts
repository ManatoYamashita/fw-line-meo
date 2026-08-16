import { randomInt } from 'node:crypto';

// 招待コード生成（design「invite-code-gen」）。
// crypto.randomInt により 31 字集合から 8 文字を生成する。外部ライブラリは使用しない。
// 0/O/1/I/L は目視・口頭伝達で紛らわしいため除外する（オーナーへの案内はアナログ経路が想定されるため）。

export const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 31 字
export const INVITE_CODE_LENGTH = 8;

// [0, maxExclusive) の一様乱数。既定は crypto.randomInt（CSPRNG）。テストでは決定的な実装を注入する。
export type RandomIntFn = (maxExclusive: number) => number;

const defaultRandomInt: RandomIntFn = (maxExclusive) => randomInt(maxExclusive);

/** 31 字集合から 8 文字の招待コードを生成する（Req 5.2）。 */
export function generateInviteCode(random: RandomIntFn = defaultRandomInt): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    // charAt は範囲外でも string を返す（noUncheckedIndexedAccess 下で undefined 混入を型から排除）。
    code += INVITE_CODE_ALPHABET.charAt(random(INVITE_CODE_ALPHABET.length));
  }
  return code;
}

/**
 * pg の unique_violation（SQLSTATE 23505）かの判定述語。
 * pg は Error 派生オブジェクトに code プロパティを持たせるため、形状で判定する。
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505'
  );
}

// 発行の合成依存: create は createInviteCode（@fwlm/db）を部分適用したもの。
// generate は既定で generateInviteCode（テストでは決定的な系列を注入する）。
export interface UniqueInviteCodeDeps<T> {
  create: (code: string) => Promise<T>;
  generate?: () => string;
}

const MAX_ATTEMPTS = 3;

/**
 * 一意な招待コードの発行（Req 5.2）。code UNIQUE の衝突（23505）時は「新しいコード」で
 * 再生成リトライする（最大 3 試行）。3 回とも衝突したら投げる（呼び出し側が 500 internal に写像）。
 * 23505 以外のエラーはリトライ対象ではないため即時 rethrow する。
 */
export async function createUniqueInviteCode<T>(deps: UniqueInviteCodeDeps<T>): Promise<T> {
  const generate = deps.generate ?? generateInviteCode;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generate(); // 毎試行、新しいコードを生成する（同一コードの再送はしない）
    try {
      return await deps.create(code);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      lastError = err;
    }
  }
  throw new Error('createUniqueInviteCode: exhausted unique-code attempts', {
    cause: lastError,
  });
}

import type { Star } from './domain';
import { ok, err, type Result } from './result';

// 回答の入力検証（サーバー側・クライアント検証を信用しない）。
// 星必須(1-5)・良かった点は取得済み code のみ・一言は 200 文字以内。
// エラーはフィールド単位で全件収集して返す（設計: 4xx はフィールド単位メッセージ）。

const COMMENT_MAX = 200;

export interface SurveyAnswerInput {
  star: Star;
  aspectCodes: string[];
  comment?: string;
}

export type FieldError =
  | { field: 'star'; code: 'REQUIRED' | 'OUT_OF_RANGE' }
  | { field: 'aspectCodes'; code: 'INVALID' | 'UNKNOWN_CODE' }
  | { field: 'comment'; code: 'INVALID' | 'TOO_LONG' };

/**
 * 回答入力を検証する。
 * @param input 未検証の JSON ボディ
 * @param allowedAspectCodes その店舗で表示した選択肢 code（seed 由来・SoT）
 */
export function validateSurveyAnswer(
  input: unknown,
  allowedAspectCodes: readonly string[],
): Result<SurveyAnswerInput, FieldError[]> {
  const errors: FieldError[] = [];
  const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

  // star: 必須・整数 1..5
  const rawStar = obj.star;
  let star: Star | undefined;
  if (rawStar == null) {
    errors.push({ field: 'star', code: 'REQUIRED' });
  } else if (
    typeof rawStar !== 'number' ||
    !Number.isInteger(rawStar) ||
    rawStar < 1 ||
    rawStar > 5
  ) {
    errors.push({ field: 'star', code: 'OUT_OF_RANGE' });
  } else {
    star = rawStar as Star;
  }

  // aspectCodes: 任意・文字列配列・全て許可 code
  const rawAspects = obj.aspectCodes;
  let aspectCodes: string[] = [];
  if (rawAspects !== undefined && rawAspects !== null) {
    if (!Array.isArray(rawAspects) || !rawAspects.every((c) => typeof c === 'string')) {
      errors.push({ field: 'aspectCodes', code: 'INVALID' });
    } else {
      const allowed = new Set(allowedAspectCodes);
      if (rawAspects.some((c) => !allowed.has(c as string))) {
        errors.push({ field: 'aspectCodes', code: 'UNKNOWN_CODE' });
      } else {
        aspectCodes = rawAspects as string[];
      }
    }
  }

  // comment: 任意・文字列・200 文字以内（空文字は未回答扱い）
  const rawComment = obj.comment;
  let comment: string | undefined;
  if (rawComment !== undefined && rawComment !== null && rawComment !== '') {
    if (typeof rawComment !== 'string') {
      errors.push({ field: 'comment', code: 'INVALID' });
    } else if ([...rawComment].length > COMMENT_MAX) {
      errors.push({ field: 'comment', code: 'TOO_LONG' });
    } else {
      comment = rawComment;
    }
  }

  if (errors.length > 0 || star === undefined) return err(errors);

  const result: SurveyAnswerInput = { star, aspectCodes };
  if (comment !== undefined) result.comment = comment;
  return ok(result);
}

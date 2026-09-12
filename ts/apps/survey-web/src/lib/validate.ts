import type { Star } from './domain';
import { ok, err, type Result } from './result';

// 回答の入力検証（サーバー側・クライアント検証を信用しない）。
// 星必須(1-5)・良かった点と気になった点は取得済み code のみ・一言は 200 文字以内。
// エラーはフィールド単位で全件収集して返す（設計: 4xx はフィールド単位メッセージ）。

const COMMENT_MAX = 200;

export interface SurveyAnswerInput {
  star: Star;
  aspectCodes: string[];
  // 気になった点（Issue #221）。省略された送信（改訂前のページを開いたままの客）は空として扱う。
  concernCodes: string[];
  comment?: string;
}

export type FieldError =
  | { field: 'star'; code: 'REQUIRED' | 'OUT_OF_RANGE' }
  | { field: 'aspectCodes'; code: 'INVALID' | 'UNKNOWN_CODE' }
  | { field: 'concernCodes'; code: 'INVALID' | 'UNKNOWN_CODE' }
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

  // aspectCodes / concernCodes: 任意・文字列配列・全て許可 code。
  // 2 つは同じ観点の集合から選ぶ（Requirement 2.4）ので、同じ規則で検証する。
  const allowed = new Set(allowedAspectCodes);
  const aspectCodes = validateCodes(obj.aspectCodes, 'aspectCodes', allowed, errors);
  const concernCodes = validateCodes(obj.concernCodes, 'concernCodes', allowed, errors);

  // comment: 任意・文字列・200 文字以内（空文字は未回答扱い）
  const rawComment = obj.comment;
  let comment: string | undefined;
  if (rawComment !== undefined && rawComment !== null && rawComment !== '') {
    if (typeof rawComment !== 'string') {
      errors.push({ field: 'comment', code: 'INVALID' });
    } else if (rawComment.trim() !== '') {
      // 空白のみは空文字と同じく「未回答」。フォームは trim 済みで送るが、直接 POST では
      // 届きうる。ここで潰しておかないと「一言あり」として素材の厚みに数えられ、
      // プロンプト側の判定（書く材料が無い）とずれる（Issue #137 段階2/3）。
      if ([...rawComment].length > COMMENT_MAX) {
        errors.push({ field: 'comment', code: 'TOO_LONG' });
      } else {
        comment = rawComment;
      }
    }
  }

  if (errors.length > 0 || star === undefined) return err(errors);

  const result: SurveyAnswerInput = { star, aspectCodes, concernCodes };
  if (comment !== undefined) result.comment = comment;
  return ok(result);
}

/**
 * 観点 code の配列を検証する。未指定は空配列（未回答）として扱う。
 * 不正ならエラーを積んで空配列を返す（呼び手はエラーの有無で成否を決める）。
 */
function validateCodes(
  raw: unknown,
  field: 'aspectCodes' | 'concernCodes',
  allowed: ReadonlySet<string>,
  errors: FieldError[],
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((c): c is string => typeof c === 'string')) {
    errors.push({ field, code: 'INVALID' });
    return [];
  }
  if (raw.some((c) => !allowed.has(c))) {
    errors.push({ field, code: 'UNKNOWN_CODE' });
    return [];
  }
  return raw;
}

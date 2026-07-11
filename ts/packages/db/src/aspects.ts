import type { Queryable } from './pool.js';
import type { SurveyAspectRow } from './types.js';

// 良かった点の選択肢（seed が SoT・コード内に二重定義しない・Req 2.4）。
export type SurveyAspect = SurveyAspectRow;

/** アンケートの良かった点選択肢を code 昇順で取得する。 */
export async function listSurveyAspects(db: Queryable): Promise<SurveyAspect[]> {
  const res = await db.query<SurveyAspectRow>(
    'SELECT code, label FROM survey_aspects ORDER BY code ASC',
  );
  return res.rows;
}

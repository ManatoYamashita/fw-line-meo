import type { Pool } from 'pg';

// 匿名集計の月次加算（review-acquisition の DB 書込・write-boundary.md: TS リアルタイム応答層）。
// 1 回答 = rating 1 行＋選択した良かった点ごとに 1 行＋選択した気になった点ごとに 1 行＋素材の厚み 1 行を
// 単一トランザクションで UPSERT する。投稿導線の押下は回答とは別の要求で、別の表へ 1 行を UPSERT する
// （incrementReviewLinkTally・Issue #401）。QR パネルの実績の読み出し（readStoreReviewFunnel）も
// 月境界の式を共有するためここに置く。
export interface TallyInput {
  storeId: string;
  star: number;
  /** 選択された良かった点の code。 */
  aspectCodes: string[];
  /**
   * 選択された気になった点の code（Issue #221）。**必須にしている。** 省略可能にすると、呼び手が
   * 渡し忘れても型検査が通り、気になった点を選んだ回答が「観点ゼロ」の厚みとして記録される。
   */
  concernCodes: string[];
  /**
   * 一言が入力されたか（Issue #137 段階3）。**本文は受け取らない。**
   *
   * 呼び手は下書きの素材へ渡すのと同じ値からこれを導くこと。別々に導くと「プロンプトが見た
   * 厚み」と「記録した厚み」がずれ、入力導線を変えた効果をこのデータで検証できなくなる。
   */
  hasComment: boolean;
}

// period_month は Asia/Tokyo 基準の月初日を SQL 側で確定（UTC ずれで隣月に入らない）。
// now を省略すると DB の now() を使う（本番）。テストは固定時刻を注入して JST 月境界を検証する。
const PERIOD_MONTH_SQL =
  "date_trunc('month', COALESCE($2::timestamptz, now()) AT TIME ZONE 'Asia/Tokyo')::date";

/**
 * 店舗×月の匿名集計に 1 回答分を加算する。
 * rating・全 aspect・全 concern・素材の厚みを単一トランザクションで処理し、いずれか失敗時は全体を
 * ロールバックする。
 *
 * 厚みを別トランザクションに分けない理由: 部分成功すると `sum(material.count)` と
 * `sum(rating.count)` が恒久的にずれる。厚みは「観点ゼロの回答が何割か」を出すための
 * 分母つきの指標なので、母数が合わない状態は指標そのものを無意味にする。
 */
export async function incrementTallies(
  pool: Pool,
  input: TallyInput,
  now?: Date,
): Promise<void> {
  const { storeId, star, hasComment } = input;
  const aspectCodes = [...new Set(input.aspectCodes)]; // 同一回答内の重複は 1 回分
  const concernCodes = [...new Set(input.concernCodes)];
  const nowParam: Date | null = now ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO survey_rating_tallies (store_id, period_month, star, count)
       VALUES ($1, ${PERIOD_MONTH_SQL}, $3, 1)
       ON CONFLICT (store_id, period_month, star)
       DO UPDATE SET count = survey_rating_tallies.count + 1`,
      [storeId, nowParam, star],
    );
    for (const code of aspectCodes) {
      await client.query(
        `INSERT INTO survey_aspect_tallies (store_id, period_month, aspect_code, count)
         VALUES ($1, ${PERIOD_MONTH_SQL}, $3, 1)
         ON CONFLICT (store_id, period_month, aspect_code)
         DO UPDATE SET count = survey_aspect_tallies.count + 1`,
        [storeId, nowParam, code],
      );
    }
    // 気になった点（Issue #221）。良かった点と同じ観点を別の表で数える。同じ表に混ぜると
    // survey_aspect_tallies の「良かった点別件数」（Requirement 5.2）の意味が壊れる。
    for (const code of concernCodes) {
      await client.query(
        `INSERT INTO survey_concern_tallies (store_id, period_month, aspect_code, count)
         VALUES ($1, ${PERIOD_MONTH_SQL}, $3, 1)
         ON CONFLICT (store_id, period_month, aspect_code)
         DO UPDATE SET count = survey_concern_tallies.count + 1`,
        [storeId, nowParam, code],
      );
    }
    // 素材の厚み（Issue #137 段階3・Issue #221）。良かった点と気になった点の選択数は、どちらも
    // **重複除去後** の件数で、それぞれの tallies の加算件数と必ず一致する。一言は有無だけで、
    // 本文は渡ってこない。
    await client.query(
      `INSERT INTO survey_material_tallies
         (store_id, period_month, aspect_count, concern_count, has_comment, count)
       VALUES ($1, ${PERIOD_MONTH_SQL}, $3, $4, $5, 1)
       ON CONFLICT (store_id, period_month, aspect_count, concern_count, has_comment)
       DO UPDATE SET count = survey_material_tallies.count + 1`,
      [storeId, nowParam, aspectCodes.length, concernCodes.length, hasComment],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * structured survey の回答 1 件の素材の厚み（Issue #436）。**個数と有無だけを受け取る。**
 *
 * 選択の中身（カテゴリ・Target の id や名前・facet の code）と一言の本文はこの関数へ渡ってこない。
 * DB へ届く前に個数へ畳むことで、個別回答を保存する経路を構造的に持たない。
 */
export interface StructuredMaterialCounts {
  /** 良かったところの選択グループ数（Category 全体 1 つ・Target 1 つがそれぞれ 1 グループ）。 */
  positiveGroupCount: number;
  /** 気になったところの選択グループ数。 */
  concernGroupCount: number;
  /** 良かったところのうち Target を指すグループ数（positiveGroupCount を超えない）。 */
  positiveTargetCount: number;
  /** 気になったところのうち Target を指すグループ数（concernGroupCount を超えない）。 */
  concernTargetCount: number;
  /** 良かったところの facet の選択数の合計。 */
  positiveFacetCount: number;
  /** 気になったところの facet の選択数の合計。 */
  concernFacetCount: number;
  /** 一言が入力されたか。**本文は受け取らない。** */
  hasComment: boolean;
}

export interface StructuredTallyInput extends StructuredMaterialCounts {
  storeId: string;
  star: number;
}

/**
 * structured survey の回答 1 件分を店舗×月の匿名集計へ加算する（Issue #436）。
 *
 * 星は legacy と同じ survey_rating_tallies へ、厚みは survey_structured_material_tallies へ、
 * 単一トランザクションで UPSERT する（母数をずらさない理由は incrementTallies と同じ）。
 * legacy の survey_aspect_tallies / survey_concern_tallies / survey_material_tallies には書かない
 * （観点の意味が違うものを同じ表へ数えない）。
 *
 * **structured の回答 1 件の集計は、この関数 1 回の呼び出しがすべてを所有する（星を含む）。**
 * 同じ回答について incrementTallies（legacy の集計・星を含む）を併せて呼んではならない。どちらも
 * survey_rating_tallies へ 1 を足すので、星が二重に数えられる。回答 1 件につき、legacy なら
 * incrementTallies、structured ならこの関数の、どちらか一方だけを呼ぶ。
 *
 * **この PR（Issue #441 の PR1）の時点では呼び手が無い。** 客向けの structured の回答受付は Issue #438 で接続する。
 */
export async function incrementStructuredTallies(
  pool: Pool,
  input: StructuredTallyInput,
  now?: Date,
): Promise<void> {
  const nowParam: Date | null = now ?? null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO survey_rating_tallies (store_id, period_month, star, count)
       VALUES ($1, ${PERIOD_MONTH_SQL}, $3, 1)
       ON CONFLICT (store_id, period_month, star)
       DO UPDATE SET count = survey_rating_tallies.count + 1`,
      [input.storeId, nowParam, input.star],
    );
    await client.query(
      `INSERT INTO survey_structured_material_tallies
         (store_id, period_month,
          positive_group_count, concern_group_count,
          positive_target_count, concern_target_count,
          positive_facet_count, concern_facet_count,
          has_comment, count)
       VALUES ($1, ${PERIOD_MONTH_SQL}, $3, $4, $5, $6, $7, $8, $9, 1)
       ON CONFLICT (store_id, period_month,
                    positive_group_count, concern_group_count,
                    positive_target_count, concern_target_count,
                    positive_facet_count, concern_facet_count,
                    has_comment)
       DO UPDATE SET count = survey_structured_material_tallies.count + 1`,
      [
        input.storeId,
        nowParam,
        input.positiveGroupCount,
        input.concernGroupCount,
        input.positiveTargetCount,
        input.concernTargetCount,
        input.positiveFacetCount,
        input.concernFacetCount,
        input.hasComment,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 投稿導線の押下を店舗×月の匿名集計へ 1 件加算する（Issue #401・review-acquisition Requirement 5.9）。
 *
 * 呼ぶのは、下書き画面の押下を sessionToken で検証できたときだけである（呼び手の責務）。記録するのは
 * 件数だけで、token・時刻は受け取らない。1 文の UPSERT なのでトランザクションを張らない。
 * 月境界は incrementTallies と同じ式で決める（加算した月と読む月がずれないように）。
 */
export async function incrementReviewLinkTally(
  pool: Pool,
  storeId: string,
  now?: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO survey_review_link_tallies (store_id, period_month, count)
     VALUES ($1, ${PERIOD_MONTH_SQL}, 1)
     ON CONFLICT (store_id, period_month)
     DO UPDATE SET count = survey_review_link_tallies.count + 1`,
    [storeId, now ?? null],
  );
}

/** QR パネルが出す 1 か月分の実績（store-qr-issuance-ui Requirement 8）。 */
export interface StoreReviewFunnelMonth {
  /** JST の暦月（`YYYY-MM`）。 */
  month: string;
  /** アンケートの回答件数（survey_rating_tallies の当該月の合計。星ごとの内訳は返さない）。 */
  responses: number;
  /** 下書き画面から Google の投稿画面へ進んだ回数（投稿された件数ではない）。 */
  reviewLinkOpens: number;
}

/**
 * 店舗の当月と前月の実績を新しい順に 2 件返す（Issue #401）。
 *
 * 行の無い月も 0 で返す（Requirement 8.7）。「当月」は DB の now() を JST で切って決め、呼び手の
 * 時計に依存させない。now はテストが月境界を固定するための注入である。
 */
export async function readStoreReviewFunnel(
  pool: Pool,
  storeId: string,
  now?: Date,
): Promise<StoreReviewFunnelMonth[]> {
  const res = await pool.query<{ month: string; responses: number; review_link_opens: number }>(
    `WITH current_month AS (SELECT ${PERIOD_MONTH_SQL} AS period_month),
          months AS (
            SELECT period_month FROM current_month
            UNION ALL
            SELECT (period_month - interval '1 month')::date FROM current_month
          )
     SELECT to_char(months.period_month, 'YYYY-MM') AS month,
            COALESCE((SELECT sum(r.count) FROM survey_rating_tallies r
                      WHERE r.store_id = $1 AND r.period_month = months.period_month), 0)::int
              AS responses,
            COALESCE((SELECT l.count FROM survey_review_link_tallies l
                      WHERE l.store_id = $1 AND l.period_month = months.period_month), 0)::int
              AS review_link_opens
     FROM months
     ORDER BY months.period_month DESC`,
    [storeId, now ?? null],
  );
  return res.rows.map((row) => ({
    month: row.month,
    responses: row.responses,
    reviewLinkOpens: row.review_link_opens,
  }));
}

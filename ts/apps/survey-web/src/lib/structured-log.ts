import type { DraftError, DraftErrorKind } from './draft/generator';

export type LogLevel = 'warn' | 'error' | 'info';
export interface SurveyLogFields {
  errorKind?: DraftErrorKind;
  status?: number;
  /**
   * 事後検証（Issue #132・案B）をもってしても下書きに残った未選択観点の **code**（カンマ区切り）。
   * 記録するのは観点の識別子だけで、下書き本文・一言・プロンプトは決して載せない。
   */
  violatedAspects?: string;
  /**
   * 店舗の識別子（Issue #137 段階3）。ファネル（表示 → 送信）を店舗単位で数えるために載せる。
   * 店舗は事業者側の識別子であって来店客の識別子ではない。**客に紐づく値は一切載せない。**
   */
  storeId?: string;
}
export type SurveyLogger = (level: LogLevel, event: string, fields?: SurveyLogFields) => void;

/** 生成失敗の診断情報だけを、プライバシーを保って記録する。 */
export function logGenerationFailure(log: SurveyLogger, error: DraftError): void {
  const fields: SurveyLogFields =
    error.kind === 'API_ERROR' && error.status !== undefined
      ? { errorKind: error.kind, status: error.status }
      : { errorKind: error.kind };

  if (error.kind === 'SAFETY_BLOCKED') {
    log('info', 'generation_safety_blocked', fields);
  } else {
    log('error', 'generation_failed', fields);
  }
}

/**
 * 事後検証（Issue #132・案B）をもってしても下書きに残った未選択観点を記録する。
 *
 * 下書き自体は客へ返すため「失敗」ではない。生成は成功しており Google 投稿導線も生きている。
 * それでも記録するのは、受け入れた残差（合意水準 11.1%）が実運用でどう推移するかを
 * 後から集計できるようにするため。level が warn なのはこの理由による（error ではない）。
 *
 * 載せるのは観点の code だけで、下書き本文・一言・プロンプトは決して含めない。
 */
export function logFactualityResidual(log: SurveyLogger, aspectCodes: readonly string[]): void {
  // 並び順を固定して集計しやすくする（同じ組み合わせが別文字列に散らばらないように）。
  log('warn', 'factuality_residual', { violatedAspects: [...aspectCodes].sort().join(',') });
}

/**
 * アンケートページが回答可能な状態で表示された（ファネルの分母・Issue #137 段階3）。
 *
 * 素材の厚みは survey_material_tallies に月次で残るが、それは **送信された回答** しか
 * 数えない。「開いたが送らなかった」を知るには表示側の数が要る。導線を変えたときに
 * 獲得率が落ちていないかを見るための指標であり、これが無いまま必須化などへ進むと
 * 効果も害も測れない（Issue #137 の「やってはいけないこと」）。
 *
 * 数え方の癖: ページは force-dynamic なので、bot・プリフェッチ・回答済みの再訪
 * （24 時間の判定は localStorage 側なので SSR は走る）も 1 件として数える。したがって
 * 「送信 / 表示」は転換率の **下限** であり、絶対値ではなく施策前後の変化を見る。
 */
export function logSurveyPageViewed(log: SurveyLogger, storeId: string): void {
  log('info', 'survey_page_viewed', { storeId });
}

/**
 * アンケートが送信された（ファネルの分子・Issue #137 段階3）。
 *
 * 送信数は tallies にも入るが、こちらは「客が送信した」という事実そのものを記録する。
 * 集計の加算は失敗しうる（Req 5.4 で客には転嫁しない）ため、**このログと tallies の
 * 乖離自体が集計障害の検知になる**。粒度も違い、tallies は月次・ログは日次で読める。
 */
export function logSurveyResponseSubmitted(log: SurveyLogger, storeId: string): void {
  log('info', 'survey_response_submitted', { storeId });
}

/**
 * Cloud Logging が解釈できる 1 行 JSON を出力する。
 *
 * 出力する項目は sink 側で明示的に取り出す。渡された object をそのまま spread すると、
 * 型検査を通り抜けた余剰プロパティ（自由記述・プロンプト・下書き本文など）が
 * Cloud Logging へ永続化される。TypeScript の excess property check は「その場で書かれた
 * object literal」にしか適用されず、変数・関数戻り値・キャスト経由の余剰プロパティは
 * 構造的部分型として合法に通るため、**型ではこの経路を塞げない**
 * （test/structured-log.test.ts で実際に混入することを実測。PR #75 レビュー指摘）。
 */
export const writeStructuredLog: SurveyLogger = (level, event, fields) => {
  console[level](
    JSON.stringify({
      level,
      event,
      ...(fields?.errorKind !== undefined ? { errorKind: fields.errorKind } : {}),
      ...(fields?.status !== undefined ? { status: fields.status } : {}),
      ...(fields?.violatedAspects !== undefined ? { violatedAspects: fields.violatedAspects } : {}),
      ...(fields?.storeId !== undefined ? { storeId: fields.storeId } : {}),
    }),
  );
};

// 上の sink は allowlist であるため、SurveyLogFields へ項目を足しても取り出しを更新しない限り
// 黙って出力されない。これは privacy には安全な方向（fail-closed）だが、「新しい診断項目が
// ログに出ない」という Issue #62 と同じ状態を再生産する。鍵集合を表明して型で強制する。
// 左辺は名前付き型ではなく **sink の実引数位置** から導く（名前付き型へ固定すると、引数の型を
// 派生型・交差型へ差し替えた瞬間に無言で無効化する）。
type EmittedLogField = 'errorKind' | 'status' | 'violatedAspects' | 'storeId';
type UnemittedLogField = Exclude<keyof NonNullable<Parameters<SurveyLogger>[2]>, EmittedLogField>;
const _allLogFieldsEmitted: never = null as unknown as UnemittedLogField;
void _allLogFieldsEmitted;

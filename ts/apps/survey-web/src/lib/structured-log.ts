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
    }),
  );
};

// 上の sink は allowlist であるため、SurveyLogFields へ項目を足しても取り出しを更新しない限り
// 黙って出力されない。これは privacy には安全な方向（fail-closed）だが、「新しい診断項目が
// ログに出ない」という Issue #62 と同じ状態を再生産する。鍵集合を表明して型で強制する。
// 左辺は名前付き型ではなく **sink の実引数位置** から導く（名前付き型へ固定すると、引数の型を
// 派生型・交差型へ差し替えた瞬間に無言で無効化する）。
type EmittedLogField = 'errorKind' | 'status' | 'violatedAspects';
type UnemittedLogField = Exclude<keyof NonNullable<Parameters<SurveyLogger>[2]>, EmittedLogField>;
const _allLogFieldsEmitted: never = null as unknown as UnemittedLogField;
void _allLogFieldsEmitted;

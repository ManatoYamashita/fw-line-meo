/**
 * アンケート面の記録（Issue #228 タスク 3.1 で共有経路へ移送）。
 *
 * 出力そのものと許可項目の型は `@fwlm/observability` が持つ。本ファイルに残るのは
 * **面に固有の事象ごとのヘルパ**だけである。
 *
 * 事象名と項目名は移送前と同一に保つ。`survey_page_viewed` と `survey_response_submitted`
 * は本番の集計指標がこの文字列で絞り込んでおり、`storeId` はラベル抽出の対象である
 * （正典 `docs/observability/log-field-canon.md`）。**重大度の項目名だけが例外**として
 * 変わる（集約基盤が解釈する名前へ改めるため。集計指標は重大度を参照していない）。
 */

import { writeStructuredLog, type LogFields, type LogLevel } from '@fwlm/observability';

import type { DraftError } from './draft/generator';

// 呼び出し側の import 経路を保つため re-export する。
export { writeStructuredLog };
export type { LogFields, LogLevel };

/** 移送前の名前。呼び出し側の型注釈を保つための別名である。 */
export type SurveyLogFields = LogFields;

/** 記録を 1 件出す契約。テストは差し替えて内容を検証する。 */
export type SurveyLogger = (level: LogLevel, event: string, fields?: LogFields) => void;

/** 生成失敗の診断情報だけを、プライバシーを保って記録する。 */
export function logGenerationFailure(log: SurveyLogger, error: DraftError): void {
  const fields: LogFields =
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
 * 後から集計できるようにするため。重大度が警告なのはこの理由による（エラーではない）。
 *
 * 載せるのは観点の code だけで、下書き本文・一言・プロンプトは決して含めない。
 */
export function logFactualityResidual(log: SurveyLogger, aspectCodes: readonly string[]): void {
  // 並び順を固定して集計しやすくする（同じ組み合わせが別文字列に散らばらないように）。
  log('warn', 'factuality_residual', { violatedAspects: [...aspectCodes].sort().join(',') });
}

/**
 * 事後検証（Issue #413）で作り直してもなお残った、来店前の期待と「無かった」の断定を記録する。
 *
 * `factuality_residual`（未選択の観点）と同じく下書きは客へ返すので、重大度は警告である。事象名を分けるのは、
 * 既存の事象の意味（未選択の観点だけ）を変えないため。載せるのは分類名だけで、下書き本文・一言・プロンプトは含めない。
 */
export function logFabricationResidual(log: SurveyLogger, categories: readonly string[]): void {
  // 並び順を固定して集計しやすくする（同じ組み合わせが別文字列に散らばらないように）。
  log('warn', 'fabrication_residual', { residualClaims: [...categories].sort().join(',') });
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
 * 投稿導線（「Google のクチコミを書く」）が押された（ファネルの送信の次の段・Issue #137）。
 *
 * Google への投稿そのものは客と Google の間で完結し、本システムは観測できない。製品の側で観測できる
 * 最後の段がこの押下である。実際に口コミが増えたかは、日次バッチが記録する自店の
 * `rating_snapshots.review_count` で読む（`docs/observability/review-acquisition-funnel.md`）。
 *
 * 呼ぶのは token を検証できた押下だけ（`app/api/review-link-opened/handler.ts`）。数え方の癖は
 * design.md の ReviewLinkAPI の節にある。
 */
export function logSurveyReviewLinkOpened(log: SurveyLogger, storeId: string): void {
  log('info', 'survey_review_link_opened', { storeId });
}

/**
 * structured の下書き（Natural LLM Realizer・Issue #439）の 1 回目が hard gate を通らず、作り直したことを記録する。
 * 載せるのは失格の種類（頭の名前）だけで、下書き・一言・料理名は載せない。
 */
export function logStructuredDraftRetry(log: SurveyLogger, kinds: readonly string[]): void {
  log('info', 'survey-web.structured_draft_retry', { residualClaims: [...kinds].sort().join(',') });
}

/**
 * structured の下書きが safe fallback（claim からの決定的なテンプレート）へ落ちたことを記録する（Issue #439）。
 * reason は `gate`（2 回とも hard gate を通らなかった）か `generation`（生成そのものの失敗）。本文は載せない。
 */
export function logStructuredDraftFallback(log: SurveyLogger, reason: 'gate' | 'generation', kinds: readonly string[]): void {
  log('warn', 'survey-web.structured_draft_fallback', { reason, residualClaims: [...kinds].sort().join(',') });
}

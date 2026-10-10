'use client';

import { useId, useState } from 'react';
import type { StructuredSurveyDefinition, SurveyCategoryDefinition, SurveyFacetOption } from '@fwlm/db';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { Checkbox } from '@fwlm/ui/components/checkbox';
import { Textarea } from '@fwlm/ui/components/textarea';
import type { Polarity, StructuredSurveyAnswer } from '../../../lib/structured-answer';
import type { Star } from '../../../lib/domain';
import {
  EMPTY_EVIDENCE,
  categoryEvidence,
  hasEvidence,
  summarizeCategory,
  summaryText,
  toSelectionGroups,
  toggleCategoryFacet,
  toggleTarget,
  toggleTargetFacet,
  type EvidenceState,
} from '../../../lib/structured-selection';

// structured survey の回答フォーム（Issue #438）。店舗別の定義（@fwlm/db の readStoreSurveyDefinition の結果）
// から、星・良かったところ・気になったところ・一言を 1 ページで尋ねる。API 呼出はシェルが所有する。
//
// 守ること（Issue #435・Issue #438）:
//   - **星だけが必須。** 星の値で設問・カテゴリ・良かったところ / 気になったところを出し分けない。
//   - **開くことは回答ではない。** カテゴリ・Target の展開状態（open）は画面の状態で、回答の意味（evidence・
//     lib/structured-selection.ts）とは別に持つ。開いて何も選ばずに閉じても、送信には何も入らない。
//   - 良かったところ / 気になったところは同じ定義・同じ部品で描く。同じ選択が両方に在ってもエラーにしない。
//   - 未選択を「なし」と読まない。文言も「問題なし」「特になし」のような意味を付けない。
//   - カテゴリ・facet・Target の名前と並びは定義（DB の taxonomy と店舗設定）だけから取る。画面に列挙しない。
//   - 各極性で大きく開くカテゴリは 1 つ、カテゴリの中で詳しく開く Target も 1 つ。別のものを開いても選択は残り、
//     折り畳んだカテゴリには選んだ内容の要約を出す（料理 10 件・ドリンク 10 件でも画面が巨大にならない）。

const COMMENT_MAX = 200;
const STARS = [1, 2, 3, 4, 5] as const;
// 一言欄の記入例。肯定と否定を 1 つずつにする（良かったことの例だけでは、低評価の客が書きにくくなる・
// survey-form.tsx の COMMENT_PLACEHOLDER と同じ判断）。
const COMMENT_PLACEHOLDER = '例）窓側の席が落ち着いた／提供まで少し待った';

// 選択の札（チェックボックスを包むラベル）。legacy の観点の札と同じ寸法・枠にする（survey-form.tsx）。
const CHIP_CLASS =
  'mr-2 mb-2 inline-flex min-h-11 items-center gap-2 rounded-lg border border-input px-4 py-2 transition-colors duration-150';

export interface StructuredSurveyFormProps {
  definition: StructuredSurveyDefinition;
  onSubmit: (answer: StructuredSurveyAnswer) => void;
  submitting: boolean;
}

export function StructuredSurveyForm({ definition, onSubmit, submitting }: StructuredSurveyFormProps) {
  const [star, setStar] = useState<Star | null>(null);
  const [evidence, setEvidence] = useState<EvidenceState>(EMPTY_EVIDENCE);
  const [comment, setComment] = useState('');
  const [showStarError, setShowStarError] = useState(false);
  const starErrorId = useId();

  function submit(): void {
    if (star === null) {
      setShowStarError(true);
      return;
    }
    const answer: StructuredSurveyAnswer = {
      star,
      positiveSelections: toSelectionGroups(evidence.positive, definition),
      concernSelections: toSelectionGroups(evidence.concern, definition),
    };
    // 空白だけの一言は未回答として扱う（legacy と同じ）。
    if (comment.trim() !== '') answer.comment = comment;
    onSubmit(answer);
  }

  return (
    <form
      className="space-y-10"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset className="space-y-2" aria-describedby={showStarError ? starErrorId : undefined}>
        <legend className="mb-2 text-lg font-semibold">今回の満足度（必須）</legend>
        {STARS.map((n) => (
          <button
            className={`min-h-11 min-w-11 px-1 text-4xl leading-none transition-colors duration-150 ${
              star !== null && n <= star ? 'text-foreground' : 'text-muted-foreground'
            }`}
            type="button"
            key={n}
            aria-label={`星${n}`}
            aria-pressed={star === n}
            onClick={() => {
              setStar(n);
              setShowStarError(false);
            }}
          >
            {star !== null && n <= star ? '★' : '☆'}
          </button>
        ))}
        {showStarError && (
          <Alert id={starErrorId} variant="destructive">
            <AlertDescription>満足度を選択してください</AlertDescription>
          </Alert>
        )}
      </fieldset>

      <PolaritySection
        polarity="positive"
        title="良かったところ（任意）"
        hint="当てはまるものを選んでください"
        definition={definition}
        evidence={evidence}
        onChange={setEvidence}
      />
      <PolaritySection
        polarity="concern"
        title="気になったところ（任意）"
        hint="あれば教えてください"
        definition={definition}
        evidence={evidence}
        onChange={setEvidence}
      />

      <label className="block">
        <span className="text-lg font-semibold">その他、伝えたいこと（任意）</span>
        <span className="mt-1 block text-sm text-muted-foreground">選択肢にないことがあれば入力してください</span>
        <Textarea
          className="mt-2"
          rows={3}
          value={comment}
          maxLength={COMMENT_MAX}
          placeholder={COMMENT_PLACEHOLDER}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>

      <Button size="lg" className="w-full" type="submit" disabled={submitting}>
        送信する
      </Button>
    </form>
  );
}

// --- 良かったところ / 気になったところ（同じ部品） ----------------------------------------

interface PolaritySectionProps {
  polarity: Polarity;
  title: string;
  hint: string;
  definition: StructuredSurveyDefinition;
  evidence: EvidenceState;
  onChange: (next: EvidenceState) => void;
}

function PolaritySection({ polarity, title, hint, definition, evidence, onChange }: PolaritySectionProps) {
  // 画面の展開状態（回答の意味ではない）。極性ごとに独立し、開いているカテゴリは 1 つまで。
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const headingId = `${polarity}-heading`;
  const summaries = definition.categories
    .map((category) => ({ category, selected: categoryEvidence(evidence, polarity, category.code) }))
    .filter(({ category, selected }) => category.code !== openCategory && hasEvidence(selected));

  return (
    <section className="space-y-3" aria-labelledby={headingId}>
      <div>
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {definition.categories.map((category) => {
          const open = openCategory === category.code;
          const selected = hasEvidence(categoryEvidence(evidence, polarity, category.code));
          return (
            <Button
              key={category.code}
              type="button"
              variant={open ? 'secondary' : 'outline'}
              aria-expanded={open}
              aria-controls={open ? panelId(polarity, category.code) : undefined}
              onClick={() => setOpenCategory(open ? null : category.code)}
            >
              {/* 選択済みは印と読み上げの両方で示す（色だけにしない）。印は読み上げから隠し、読み上げ名は
                  「料理（選択あり）」にする。 */}
              {selected ? <span aria-hidden="true">✓ </span> : null}
              {category.label}
              {selected ? <span className="sr-only">（選択あり）</span> : null}
            </Button>
          );
        })}
      </div>
      {summaries.length === 0 ? null : (
        <ul className="space-y-1 text-sm" aria-label={`${title.replace('（任意）', '')}で選んだ内容`}>
          {summaries.map(({ category, selected }) => (
            <li key={category.code}>
              ✓ {category.label}：{summaryText(summarizeCategory(selected, category), category)}
            </li>
          ))}
        </ul>
      )}
      {definition.categories
        .filter((category) => category.code === openCategory)
        .map((category) => (
          <CategoryPanel
            key={category.code}
            polarity={polarity}
            category={category}
            evidence={evidence}
            onChange={onChange}
          />
        ))}
    </section>
  );
}

function panelId(polarity: Polarity, categoryCode: string): string {
  return `${polarity}-panel-${categoryCode}`;
}

// --- 開いたカテゴリ -----------------------------------------------------------------------

interface CategoryPanelProps {
  polarity: Polarity;
  category: SurveyCategoryDefinition;
  evidence: EvidenceState;
  onChange: (next: EvidenceState) => void;
}

function CategoryPanel({ polarity, category, evidence, onChange }: CategoryPanelProps) {
  // カテゴリの中で詳しく開いている Target（画面の状態）。1 件ずつ開く。
  const [openTarget, setOpenTarget] = useState<string | null>(null);
  const selected = categoryEvidence(evidence, polarity, category.code);
  const titleId = `${polarity}-panel-title-${category.code}`;

  const categoryFacets = (
    <FacetChips
      idPrefix={`${polarity}-${category.code}-all`}
      facets={category.categoryFacets}
      checked={(code) => selected.categoryFacets.has(code)}
      onToggle={(code) => onChange(toggleCategoryFacet(evidence, polarity, category.code, code))}
    />
  );

  return (
    <div
      id={panelId(polarity, category.code)}
      role="group"
      aria-labelledby={titleId}
      className="space-y-4 rounded-lg border border-input p-4"
    >
      <p id={titleId} className="font-semibold">
        {category.label}
      </p>
      {!category.allowsTargets ? (
        categoryFacets
      ) : (
        <>
          <div>
            <p className="mb-2 text-sm font-medium">{category.label}全体について</p>
            {categoryFacets}
          </div>
          {category.targets.length === 0 ? null : (
            <div>
              <p className="mb-2 text-sm font-medium">具体的な{category.label}</p>
              <ul className="space-y-2">
                {category.targets.map((target) => {
                  const targetFacets = selected.targets.get(target.id);
                  const isSelected = targetFacets !== undefined;
                  const isOpen = isSelected && openTarget === target.id;
                  const chipId = `${polarity}-${category.code}-target-${target.id}`;
                  return (
                    <li key={target.id} className="space-y-2">
                      <label className={CHIP_CLASS}>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => {
                            onChange(toggleTarget(evidence, polarity, category.code, target.id));
                            // 選んだ Target は詳しく開く（他の Target は要約のまま残る）。外したら閉じる。
                            setOpenTarget(isSelected ? null : target.id);
                          }}
                          aria-labelledby={chipId}
                        />
                        <span id={chipId}>{target.label}</span>
                      </label>
                      {isSelected && !isOpen ? (
                        <div className="flex flex-wrap items-center gap-2 pl-2 text-sm">
                          {targetFacets.size > 0 ? (
                            <span>
                              {category.targetFacets
                                .filter((f) => targetFacets.has(f.code))
                                .map((f) => f.label)
                                .join('・')}
                            </span>
                          ) : null}
                          <Button
                            type="button"
                            variant="ghost"
                            aria-expanded={false}
                            aria-label={`${target.label}について詳しく選ぶ`}
                            onClick={() => setOpenTarget(target.id)}
                          >
                            詳しく選ぶ
                          </Button>
                        </div>
                      ) : null}
                      {isOpen ? (
                        <div className="ml-2 border-l-2 border-input pl-3">
                          <p className="mb-2 text-sm font-medium">{target.label}について</p>
                          <FacetChips
                            idPrefix={`${polarity}-${category.code}-${target.id}`}
                            facets={category.targetFacets}
                            checked={(code) => targetFacets.has(code)}
                            onToggle={(code) =>
                              onChange(toggleTargetFacet(evidence, polarity, category.code, target.id, code))
                            }
                          />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- facet の札 ----------------------------------------------------------------------------

interface FacetChipsProps {
  /** id の接頭辞。極性・カテゴリ・Target ごとに分け、読み上げ名の参照先を衝突させない。 */
  idPrefix: string;
  facets: SurveyFacetOption[];
  checked: (code: string) => boolean;
  onToggle: (code: string) => void;
}

function FacetChips({ idPrefix, facets, checked, onToggle }: FacetChipsProps) {
  return (
    <div>
      {facets.map((facet) => {
        const id = `${idPrefix}-${facet.code}`;
        return (
          // 読み上げ名は可視の文言そのものを指す（survey-form.tsx の観点の札と同じ理由）。
          <label className={CHIP_CLASS} key={facet.code}>
            <Checkbox checked={checked(facet.code)} onCheckedChange={() => onToggle(facet.code)} aria-labelledby={id} />
            <span id={id}>{facet.label}</span>
          </label>
        );
      })}
    </div>
  );
}

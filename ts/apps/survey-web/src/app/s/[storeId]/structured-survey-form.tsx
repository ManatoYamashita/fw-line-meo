'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { StructuredSurveyDefinition, SurveyCategoryDefinition, SurveyFacetOption } from '@fwlm/db';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { Checkbox } from '@fwlm/ui/components/checkbox';
import { Spinner } from '@fwlm/ui/components/spinner';
import { Textarea } from '@fwlm/ui/components/textarea';
import type { Polarity, StructuredSurveyAnswer } from '../../../lib/structured-answer';
import type { Star } from '../../../lib/domain';
import {
  EMPTY_EVIDENCE,
  MIN_MATERIALS,
  categoryEvidence,
  countMaterials,
  countPolarityMaterials,
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
// 選んだ札は枠・面・字の太さでも示す（スマホで一覧したとき、小さなチェック印だけでは見落とすため）。
// 色だけには頼らない: チェック印（Checkbox の中の ✓）と字の太さが色と別の手掛かりとして残る。
const CHIP_CLASS =
  'mr-2 mb-2 inline-flex min-h-11 items-center gap-2 rounded-lg border border-input px-4 py-2 transition-colors duration-150 has-[[data-checked]]:border-primary has-[[data-checked]]:bg-primary/10 has-[[data-checked]]:font-semibold';

// 生成に時間がかかっているときの案内へ切り替えるまでの時間。数秒で返る通常の生成では出さず、
// 「固まった」と感じ始める前に、まだ処理中であることを言い直す。
const SLOW_NOTICE_MS = 8000;

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
  // 一言欄の開閉（画面の状態）。閉じても comment は残し、送信にも載せる。
  const [commentOpen, setCommentOpen] = useState(false);
  const [slow, setSlow] = useState(false);
  const starErrorId = useId();
  const commentPanelId = useId();
  const submitNoteId = useId();
  // 口コミ文を作るには、星に加えて独立した回答材料が MIN_MATERIALS 件要る（良かったところ・気になったところの合計）。
  // 数えるのは送信される evidence だけで、カテゴリを開いただけ・星・一言は数えない（lib/structured-selection.ts）。
  const materials = countMaterials(evidence, definition);
  const enoughMaterials = materials >= MIN_MATERIALS;
  const commentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!submitting) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [submitting]);

  function submit(): void {
    // 二重送信を止める（押しボタンの disabled に加えて、Enter での送信も弾く）。
    if (submitting || !enoughMaterials) return;
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

      {/* 良かったところを主の入力として常に開き、気になったところは任意の補助として最初は畳む（必要な人だけ開く）。
          畳んでも入口は常に見え、選んだ内容は消えずに送信・件数に含まれる。部品・操作・回答の意味は同じ。 */}
      <PolaritySection
        polarity="positive"
        emphasis="primary"
        title="良かったところを教えてください"
        hint="当てはまるものをいくつでも選べます"
        summaryLabel="良かったところで選んだ内容"
        definition={definition}
        evidence={evidence}
        onChange={setEvidence}
      />
      <PolaritySection
        polarity="concern"
        emphasis="secondary"
        title="気になったところ（任意）"
        hint="当てはまるものがあれば選んでください"
        summaryLabel="気になったところで選んだ内容"
        definition={definition}
        evidence={evidence}
        onChange={setEvidence}
      />

      {/* 一言は任意。タップだけで回答できることを優先し、最初は開く押しボタンだけを出す。 */}
      <div className="space-y-2">
        <DisclosureToggle
          label="その他の感想（任意）"
          open={commentOpen}
          controls={commentPanelId}
          status={comment.trim() !== '' ? '入力済み' : null}
          onToggle={() => {
            const next = !commentOpen;
            setCommentOpen(next);
            // 開いたら入力欄へ焦点を移す（押した直後に書き始められる）。
            if (next) requestAnimationFrame(() => commentRef.current?.focus());
          }}
        />
        {commentOpen ? (
          <label id={commentPanelId} className="block">
            <span className="text-sm text-muted-foreground">その他に伝えたいことがあれば入力してください</span>
            <Textarea
              ref={commentRef}
              className="mt-2"
              rows={3}
              value={comment}
              maxLength={COMMENT_MAX}
              placeholder={COMMENT_PLACEHOLDER}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
        ) : null}
      </div>

      <div className="space-y-3">
        {/* 材料が足りない間は押せない。押せない理由と今の数は直下の案内が示す（星の未入力は従来どおり押して知らせる）。 */}
        <Button
          size="lg"
          className="w-full"
          type="submit"
          disabled={submitting || !enoughMaterials}
          aria-busy={submitting}
          aria-describedby={submitNoteId}
        >
          {submitting ? (
            <>
              {/* 図形は装飾。状態は直下の文言で伝える（動きを止める設定でも読める）。 */}
              {/* 部品の読み上げ名（動き低減時に可視化される「読み込み中」）は空にする。状態は直下の文言が伝えるので、
                  押しボタンの中で文言を二重に出さない（狭い画面で折り返さない押しボタンからはみ出す）。 */}
              <Spinner aria-hidden aria-label="" />
              口コミ文を作成しています…
            </>
          ) : (
            '口コミ文を作る'
          )}
        </Button>
        {/* 押しボタンの補足（あと何件か・生成中）。容器を常時マウントし、中身だけを差し替える（挿入と同時の領域は
            読み上げが発火しない・draft-panel.tsx の notification と同じ理由）。文言が変わるのは件数の段階と生成の
            開始・長引いたときだけなので、選ぶたびに読み上げが続くことはない。
            「AI」の語は出さない（下書きパネルと揃える・Issue #179）。伝えるのは手段ではなく、回答から文章を作ること。 */}
        <div role="status">
          <p id={submitNoteId} className="text-center text-sm text-muted-foreground">
            {submitting
              ? slow
                ? '少し時間がかかっています。画面を閉じずにこのままお待ちください'
                : '回答内容をもとに文章を作成しています'
              : enoughMaterials
                ? '回答内容をもとに文章を作成します'
                : materials === 0
                  ? `感想を${MIN_MATERIALS}つ以上選ぶと口コミ文を作れます`
                  : `あと${MIN_MATERIALS - materials}つ選ぶと口コミ文を作れます`}
          </p>
        </div>
      </div>
    </form>
  );
}

// --- 良かったところ / 気になったところ（同じ部品） ----------------------------------------

interface PolaritySectionProps {
  polarity: Polarity;
  /** 見た目の優先度。primary = 良かったところ（主の入力）、secondary = 気になったところ（任意の補助）。 */
  emphasis: 'primary' | 'secondary';
  title: string;
  hint: string;
  /** 折り畳んだカテゴリの要約一覧の読み上げ名。 */
  summaryLabel: string;
  definition: StructuredSurveyDefinition;
  evidence: EvidenceState;
  onChange: (next: EvidenceState) => void;
}

function PolaritySection({
  polarity,
  emphasis,
  title,
  hint,
  summaryLabel,
  definition,
  evidence,
  onChange,
}: PolaritySectionProps) {
  // 画面の展開状態（回答の意味ではない）。極性ごとに独立し、開いているカテゴリは 1 つまで。
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  // 極性そのものの開閉（secondary だけが畳める）。畳んでも evidence はフォームが持つので消えない。
  // この部品は畳んでもマウントされたままなので、開き直したときに開いていたカテゴリも戻る。
  const collapsible = emphasis === 'secondary';
  const [expanded, setExpanded] = useState(!collapsible);
  const headingId = `${polarity}-heading`;
  const bodyId = `${polarity}-body`;
  const selectedCount = collapsible ? countPolarityMaterials(evidence[polarity], definition) : 0;
  const summaries = definition.categories
    .map((category) => ({ category, selected: categoryEvidence(evidence, polarity, category.code) }))
    .filter(({ category, selected }) => category.code !== openCategory && hasEvidence(selected));

  return (
    <section
      className="space-y-3"
      aria-labelledby={headingId}
    >
      {collapsible ? (
        // 見出しの中に開閉の押しボタンを置く（見出しで移動したとき、その場で開ける）。領域の名前は件数を含まない
        // 見出しの文言だけにする。
        <h2 className="text-base font-medium">
          <DisclosureToggle
            label={title}
            labelId={headingId}
            open={expanded}
            controls={bodyId}
            status={selectedCount > 0 ? `${selectedCount}件選択済み` : null}
            onToggle={() => setExpanded(!expanded)}
          />
        </h2>
      ) : (
        <div>
          <h2 id={headingId} className="text-xl font-bold">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
      )}
      {expanded ? (
        <div id={bodyId} className="space-y-3">
          {collapsible ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
          <div className="flex flex-wrap gap-2">
            {definition.categories.map((category) => {
              const open = openCategory === category.code;
              const selected = hasEvidence(categoryEvidence(evidence, polarity, category.code));
              return (
                <Button
                  key={category.code}
                  type="button"
                  variant={open ? 'secondary' : 'outline'}
                  // 選択済みのカテゴリは枠でも示す（✓ と読み上げに加えて、閉じた状態でも一目で分かるように）。
                  className={selected ? 'border-primary font-semibold' : undefined}
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
            <ul className="space-y-1 text-sm" aria-label={summaryLabel}>
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
        </div>
      ) : null}
    </section>
  );
}

// --- 任意の項目の開閉 ------------------------------------------------------------------------

interface DisclosureToggleProps {
  label: string;
  /** label の文言を包む要素の id（領域の名前として指すとき）。 */
  labelId?: string;
  open: boolean;
  /** 開いているときに出る中身の id。 */
  controls: string;
  /** 畳んでいるときに添える状態（「2件選択済み」「入力済み」）。無ければ null。 */
  status: string | null;
  onToggle: () => void;
}

// 押しボタン部品の寸法区分（固定の高さ・折り返さない）では狭い画面で文言がはみ出すので、素の要素で描く。
// 焦点の指標は theme.css の :focus-visible が全要素に当てる。ラベルは折り返さない（「（任意）」だけが次の行に割れない）。開閉は ＋／− の印だけに頼らず、aria-expanded と
// 文言（開いているときの「閉じる」・畳んでいるときの状態）でも伝える。印は読み上げから隠す。
function DisclosureToggle({ label, labelId, open, controls, status, onToggle }: DisclosureToggleProps) {
  return (
    <button
      type="button"
      className="flex min-h-11 w-full flex-wrap items-center gap-x-2 rounded-lg px-1 py-1 text-left text-base font-medium"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
    >
      <span aria-hidden="true">{open ? '−' : '＋'}</span>
      <span id={labelId} className="whitespace-nowrap">
        {label}
      </span>
      {open ? (
        <span className="ml-auto shrink-0 text-sm font-normal text-muted-foreground">閉じる</span>
      ) : status !== null ? (
        // 狭い画面で収まらないときは、ラベルを割らずに状態だけを次の行へ回す。
        <span className="whitespace-nowrap text-sm font-normal text-primary">✓ {status}</span>
      ) : null}
    </button>
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

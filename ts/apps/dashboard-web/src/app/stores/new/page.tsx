'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Badge } from '@fwlm/ui/components/badge';
import { Button } from '@fwlm/ui/components/button';
import { Card, CardContent } from '@fwlm/ui/components/card';
import { Field, FieldGroup, FieldLabel } from '@fwlm/ui/components/field';
import { Heading } from '@fwlm/ui/components/heading';
import { Input } from '@fwlm/ui/components/input';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { Select } from '@fwlm/ui/components/select';
import { Spinner } from '@fwlm/ui/components/spinner';
import { AuthGuard } from '../../../components/auth-guard';
import { OwnerRosterTable, ownerDistinctLabel } from '../../../components/owner-roster-table';
import { TopNav } from '../../../components/top-nav';
import { notifyActionError, notifyActionInfo, notifyActionSuccess } from '../../../lib/action-feedback';
import { loadAgencyRoster, loadStoresByOwner, type OwnerStoresLoad } from '../../../lib/agency-roster';
import { useAuth } from '../../../lib/auth-context';
import { getAgencies, getCategories, registerStore, searchStores } from '../../../lib/api';
import type {
  AgencyItem,
  Category,
  OwnerListItem,
  StoreCandidate,
  StoreSearchResult,
} from '../../../lib/types';

// ウィザードの段階。オーナー選択 → 店名検索 → 候補確認 → 基本情報 → 完了。
type Step = 'owner' | 'search' | 'confirm' | 'basic' | 'done';

/**
 * 段階表示の並び。段の識別子と表示名を 1 箇所で持つ。
 *
 * 各段の見出し（h2）と別々に文字列を書かない。書き分けると、片方だけを直したときに
 * 「進行の 3 番目」と「今描かれている見出し」が食い違い、それを検出するものが無くなる。
 */
const WIZARD_STEPS: readonly { readonly step: Step; readonly label: string }[] = [
  { step: 'owner', label: 'オーナー選択' },
  { step: 'search', label: '店名検索' },
  { step: 'confirm', label: '店舗の確認' },
  { step: 'basic', label: '基本情報' },
  { step: 'done', label: '完了' },
];

// 検索の状態（0 件・失敗・成功を判別共用体で表す。Req 3.4/3.5/3.6）。
// 候補は「確定に送る候補」と「登録済みの注釈」を分けて持つ（Issue #485）。
type SearchState =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'found'; results: StoreSearchResult[] }
  | { kind: 'empty' }
  | { kind: 'error' };

// 確定送信の結果（成功・既登録・権限外・その他障害）。
type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success' }
  | { kind: 'conflict' }
  | { kind: 'forbidden' }
  | { kind: 'error' };

// 運営の代理店一覧の取得状態。失敗を「代理店がありません」と出さない（Req 7.4）。
type AgenciesState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'loaded'; agencies: AgencyItem[] };

/**
 * 1 代理店ぶんの「オーナー＋店舗」の取得状態（Issue #485）。
 *
 * 代理店 id をキーにした表（`rosters`）で持つ。応答は自分のキーへ書くので、代理店を素早く
 * 開き直しても、後から届いた応答が別の代理店の一覧を上書きすることは構造的に起きない。
 * 一度読んだ代理店は閉じて開き直しても取り直さない。
 */
type RosterState =
  | { kind: 'loading' }
  | { kind: 'error'; retrying: boolean }
  | {
      kind: 'loaded';
      owners: readonly OwnerListItem[];
      stores: OwnerStoresLoad;
      storesRetrying: boolean;
    };

// 代理店ロールの表のキー（自代理店はサーバーが固定するので、代理店 id を画面で持たない）。
const SELF_ROSTER_KEY = 'self';

// 登録先として選んだオーナー。運営は代理店名も添えて示す（agency は代理店ロールで null）。
interface SelectedOwner {
  owner: OwnerListItem;
  agency: AgencyItem | null;
}

// 代理店一覧（運営）の取得失敗。画面全体を読み直す以外に回復の手段が無いので、その旨を案内する。
const AGENCY_LOAD_ERROR_TEXT =
  'オーナー情報を読み込めませんでした。通信状況を確認して、画面を再読み込みしてください。';
// 1 代理店ぶんのオーナーの取得失敗。区画ごとに読み直せる（Issue #485）。
const OWNER_LOAD_ERROR_TEXT =
  'オーナー情報を読み込めませんでした。通信状況を確認して、もう一度読み込んでください。';
// オーナーは取れたが店舗だけ失敗した。選択は続けられるが、0 件とは出さない（Req 7.4）。
const STORE_LOAD_ERROR_TEXT =
  '登録済みの店舗を読み込めませんでした。通信状況を確認して、もう一度読み込んでください。';
// 選択可能オーナーが 0 件のとき、招待コード先行の必要を案内する（Req 3.3）。
const NO_OWNERS_TEXT =
  '対象オーナーがいません。オーナーが先に LINE で招待コード入力を済ませる必要があります。';

/**
 * 5 段階の進行。現在地を支援技術と視覚の両方へ、**同じ判定から**提示する。
 *
 * ナビゲーション領域（`<nav>`）にはしない。この面は既に帯（TopNav）を描いており、
 * 2 つ目のナビゲーション領域が増えると既存の構造契約が壊れる（Req 3.3）。
 * 順序のあるリストと `aria-current="step"` で表すのが、領域を増やさない唯一の形である。
 *
 * 現在地の下線は class の条件分岐ではなく **DOM 上の属性を CSS セレクタが拾って** 出す
 * （正典 §7.8 が帯について定めた形と同型）。全項目の class 文字列が同一になるため、
 * 「印は付くのに線が出ない」「線は出るのに印が無い」状態を規律ではなく構造で排除できる。
 * `border-current` は currentColor を借りるので「面の側に置く色」の集合を 1 件も広げない。
 */
function WizardProgress({ current }: { current: Step }) {
  return (
    <ol
      // Preflight が `list-style: none` を与えるため、一部のブラウザは一覧の意味論を落とす。
      // 明示しておかないと、この段階表示そのものが支援技術から一覧として読まれない。
      role="list"
      aria-label="登録の進行"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
    >
      {WIZARD_STEPS.map((item, index) => (
        <li
          key={item.step}
          aria-current={item.step === current ? 'step' : undefined}
          className="border-b-2 border-transparent pb-1 aria-[current=step]:border-current aria-[current=step]:font-semibold"
        >
          {index + 1}. {item.label}
        </li>
      ))}
    </ol>
  );
}

/**
 * 処理中の表示。Spinner 自身も role="status" を持つため、読み上げはこの行に一本化する。
 * 図形は装飾として扱い aria-hidden で支援技術から外す。文言は可視のテキストのまま
 * 残す（Spinner の aria-label へ移すと sr-only の子要素へ落ちる・Req 4.5）。
 */
function LoadingLine() {
  return (
    <p role="status" className="flex items-center gap-2">
      <Spinner aria-hidden />
      読み込み中...
    </p>
  );
}

/** 失敗の通知と、その場で読み直す押しボタン。失敗の案内は回復の手段を示す。 */
function RetryableError({
  text,
  retrying,
  onRetry,
}: {
  text: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねると
        * 読み上げ領域が二重になるため、文言は説明の受け口へ置くだけにする。 */}
      <Alert variant="destructive">
        <AlertDescription>{text}</AlertDescription>
      </Alert>
      <Button
        type="button"
        variant="outline"
        disabled={retrying}
        aria-busy={retrying}
        onClick={onRetry}
      >
        {retrying && <Spinner aria-hidden />}
        もう一度読み込む
      </Button>
    </div>
  );
}

/**
 * 1 代理店ぶんのオーナーの表と、読み込み中・失敗・0 件の出し分け。
 *
 * 失敗を 0 件に化けさせない（Req 7.4）。Req 3.3 の案内は取得に成功して 0 件のときだけ出し、
 * 店舗だけの失敗では表を出したまま上に通知を置く（オーナーは選べる）。
 */
function OwnerRoster({
  state,
  tableLabel,
  onRetry,
  onRetryStores,
  onSelect,
}: {
  state: RosterState | undefined;
  tableLabel: string;
  onRetry: () => void;
  onRetryStores: () => void;
  onSelect: (owner: OwnerListItem) => void;
}) {
  if (state === undefined || state.kind === 'loading') return <LoadingLine />;
  if (state.kind === 'error') {
    return <RetryableError text={OWNER_LOAD_ERROR_TEXT} retrying={state.retrying} onRetry={onRetry} />;
  }
  if (state.owners.length === 0) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{NO_OWNERS_TEXT}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {state.stores.kind === 'error' && (
        <RetryableError
          text={STORE_LOAD_ERROR_TEXT}
          retrying={state.storesRetrying}
          onRetry={onRetryStores}
        />
      )}
      <OwnerRosterTable
        label={tableLabel}
        owners={state.owners}
        stores={state.stores}
        renderAction={(owner) => (
          // **行全体は押せるようにしない**（正典 §7.2）。選択と前進はこの押しボタンが兼ねる。
          // 読み上げ名は「{表示名}を選ぶ」。見た目の「選ぶ」を名前の末尾に含める（WCAG 2.5.3）。
          // 「選ぶ」だけが並ぶと行を区別できない。表示名を視覚的に隠した子要素で前置する形は採らない。
          // 隠す要素は絶対配置でブロック化し、名前の算出が区切りの空白を挟んで「…を 選ぶ」へ変わる
          // （実測で確認した。候補の押しボタンが aria-label で名前を固定しているのと同じ理由）。
          <Button
            type="button"
            aria-label={`${ownerDistinctLabel(owner)}を選ぶ`}
            onClick={() => onSelect(owner)}
          >
            選ぶ
          </Button>
        )}
      />
    </div>
  );
}

/** 登録先のオーナー（運営は代理店名を添える）。検索以降の段でオーナー選択の誤りに気づけるようにする。 */
function ownerTargetText(selected: SelectedOwner): string {
  const agency = selected.agency === null ? '' : `（${selected.agency.name}）`;
  return `登録先のオーナー: ${ownerDistinctLabel(selected.owner)}${agency}`;
}

/**
 * 登録済みの候補（Issue #485）。**押しボタンにしない。**
 *
 * 無効属性の押しボタンは焦点が当たらず、支援技術の利用者には理由ごと見えなくなる。押せないものは
 * 押せる形で描かず、題名・住所・「登録済み」のラベルと理由の文を並べる。
 */
function RegisteredCandidate({ candidate }: { candidate: StoreCandidate }) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* 横並びの子なので、長い店名が面を押し広げないよう縮められるようにする（正典 §6）。 */}
          <span className="min-w-0">{candidate.name}</span>
          <Badge variant="outline">登録済み</Badge>
        </span>
        <span className="text-xs">（{candidate.address}）</span>
        <span className="text-xs">この店舗はすでに登録されています</span>
      </CardContent>
    </Card>
  );
}

function RegisterWizard() {
  const { me } = useAuth();
  const isOperator = me?.role === 'operator';

  // operator の代理店一覧と、開いている代理店の区画。開閉の状態はウィザードの側に持つ
  // （オーナー選択の段の中に持つと、「オーナーを選び直す」で戻ったときに消える）。
  const [agencies, setAgencies] = useState<AgenciesState>({ kind: 'loading' });
  const [openAgencyIds, setOpenAgencyIds] = useState<ReadonlySet<string>>(new Set());
  // 代理店 id（代理店ロールは SELF_ROSTER_KEY）→ オーナー＋店舗の取得状態。
  const [rosters, setRosters] = useState<ReadonlyMap<string, RosterState>>(new Map());
  // 取得を始めたキー。状態の更新は次の描画まで見えないので、同じ区画の二重の取得をここで弾く。
  const requestedRosters = useRef(new Set<string>());

  const [selected, setSelected] = useState<SelectedOwner | null>(null);
  const [step, setStep] = useState<Step>('owner');

  // 店名検索。
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' });

  // クライアント側で保持する確定対象候補（検索応答をそのまま verbatim で送る）。
  const [candidate, setCandidate] = useState<StoreCandidate | null>(null);

  // 基本情報。
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryCode, setCategoryCode] = useState('');

  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });

  // 段を移ると、押した押しボタンごと前の段が消え、焦点が文書の先頭へ落ちる。移った段の見出しへ
  // 焦点を移す。最初の表示では動かさない（利用者が何も操作していないのに焦点を奪わない）。
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusStepHeading = useRef(false);
  useEffect(() => {
    if (!focusStepHeading.current) return;
    focusStepHeading.current = false;
    stepHeadingRef.current?.focus();
  }, [step]);

  function goToStep(next: Step) {
    focusStepHeading.current = true;
    setStep(next);
  }

  // 画面を離れた後に届いた応答で state を書かないための印。
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function setRoster(key: string, state: RosterState) {
    setRosters((current) => new Map(current).set(key, state));
  }

  async function fetchRoster(key: string, agencyId: string | undefined) {
    const result = await loadAgencyRoster({ agencyId });
    if (!mounted.current) return;
    setRoster(
      key,
      result.kind === 'loaded'
        ? { kind: 'loaded', owners: result.owners, stores: result.stores, storesRetrying: false }
        : { kind: 'error', retrying: false },
    );
  }

  // その代理店の分をまだ読んでいなければ読む。運営は代理店 id を渡し、代理店ロールは渡さない。
  function ensureRoster(key: string, agencyId: string | undefined) {
    if (requestedRosters.current.has(key)) return;
    requestedRosters.current.add(key);
    setRoster(key, { kind: 'loading' });
    void fetchRoster(key, agencyId);
  }

  // オーナーの取得の失敗からの読み直し。失敗の通知と押しボタンを残したまま待つ。
  function retryRoster(key: string, agencyId: string | undefined) {
    setRoster(key, { kind: 'error', retrying: true });
    void fetchRoster(key, agencyId);
  }

  // 店舗だけの読み直し。オーナーの表は出したまま、店舗の列だけを差し替える。
  async function retryStores(key: string, agencyId: string | undefined) {
    const current = rosters.get(key);
    if (current?.kind !== 'loaded') return;
    setRoster(key, { ...current, storesRetrying: true });
    const stores = await loadStoresByOwner({ agencyId });
    if (!mounted.current) return;
    setRosters((latest) => {
      const roster = latest.get(key);
      if (roster?.kind !== 'loaded') return latest;
      return new Map(latest).set(key, { ...roster, stores, storesRetrying: false });
    });
  }

  // operator: 代理店一覧だけを読む。オーナーと店舗は区画を開いたときに、その代理店の分だけ読む。
  useEffect(() => {
    if (!isOperator) return;
    let active = true;
    void (async () => {
      const result = await getAgencies();
      if (!active) return;
      if (!result.ok) {
        setAgencies({ kind: 'error' });
        return;
      }
      setAgencies({ kind: 'loaded', agencies: result.value });
      // 代理店が 1 件だけのときは開いた状態で始める（開く操作を 1 回省く）。
      const only = result.value.length === 1 ? result.value[0] : undefined;
      if (only !== undefined) {
        setOpenAgencyIds(new Set([only.id]));
        ensureRoster(only.id, only.id);
      }
    })();
    return () => {
      active = false;
    };
    // ensureRoster を依存に入れない。描画ごとに作り直されるが、使う ref と state の更新関数は不変である。
  }, [isOperator]);

  // agency: 自代理店のオーナーと店舗を読む（代理店の段は出さない）。
  useEffect(() => {
    if (isOperator) return;
    ensureRoster(SELF_ROSTER_KEY, undefined);
  }, [isOperator]);

  // 基本情報ステップに入ったらカテゴリを読み込む（任意項目のため失敗しても未選択で継続可）。
  useEffect(() => {
    if (step !== 'basic') return;
    let active = true;
    void (async () => {
      const result = await getCategories();
      if (!active) return;
      if (result.ok) setCategories(result.value);
    })();
    return () => {
      active = false;
    };
  }, [step]);

  // 区画の開閉。ネイティブの <details> が開閉とその読み上げを持ち、ここは開いている集合を写すだけ。
  // 開いたときだけ、その代理店の分を読む（最初の表示では GET /owners・GET /stores を呼ばない）。
  function handleAgencyToggle(agencyId: string, open: boolean) {
    setOpenAgencyIds((current) => {
      if (current.has(agencyId) === open) return current;
      const next = new Set(current);
      if (open) next.add(agencyId);
      else next.delete(agencyId);
      return next;
    });
    if (open) ensureRoster(agencyId, agencyId);
  }

  function handleSelectOwner(owner: OwnerListItem, agency: AgencyItem | null) {
    setSelected({ owner, agency });
    goToStep('search');
  }

  async function handleSearch() {
    const trimmed = query.trim();
    if (trimmed === '') return;
    setSearch({ kind: 'searching' });
    const result = await searchStores(trimmed);
    if (result.ok) {
      // 候補は最大10件（サーバー保証だが UI 側でも切り詰める）。
      const results = result.value.slice(0, 10);
      setSearch(results.length === 0 ? { kind: 'empty' } : { kind: 'found', results });
      if (results.length === 0) {
        notifyActionInfo({
          title: '店舗が見つかりませんでした',
          description: '店名の表記を変えて、もう一度検索してください。',
        });
      } else {
        const registered = results.filter((item) => item.alreadyRegistered).length;
        notifyActionSuccess({
          title:
            registered === 0
              ? `${results.length}件の店舗候補が見つかりました。`
              : `${results.length}件の店舗候補が見つかりました（うち登録済み ${registered}件）。`,
        });
      }
    } else {
      setSearch({ kind: 'error' });
      notifyActionError({
        title: '店舗を検索できませんでした',
        description: '通信状況を確認して、時間をおいてもう一度お試しください。',
      });
    }
  }

  async function handleConfirm() {
    if (candidate === null || selected === null) return;
    setSubmit({ kind: 'submitting' });
    const result = await registerStore({
      ownerId: selected.owner.id,
      candidate,
      categoryCode: categoryCode === '' ? undefined : categoryCode,
    });
    if (result.ok) {
      setSubmit({ kind: 'success' });
      goToStep('done');
      notifyActionSuccess({ title: '店舗を登録しました。' });
    } else if (result.code === 'place_already_registered') {
      // 検索時の照合（Issue #485）は、検索から確定までの間に他の人が登録する競合を防げない。
      // 確定時の 409 はその最後の網なので残す（Req 3.9）。
      setSubmit({ kind: 'conflict' });
      notifyActionError({
        title: '店舗を登録できません',
        description: 'この店舗は既に登録されています。',
      });
    } else if (result.code === 'forbidden') {
      setSubmit({ kind: 'forbidden' });
      notifyActionError({
        title: '店舗を登録できません',
        description: 'この操作を行う権限がありません。運営までお問い合わせください。',
      });
    } else {
      setSubmit({ kind: 'error' });
      notifyActionError({
        title: '店舗を登録できませんでした',
        description: '通信状況を確認して、時間をおいてもう一度お試しください。',
      });
    }
  }

  const allRegistered =
    search.kind === 'found' && search.results.every((item) => item.alreadyRegistered);

  return (
    // オーナー選択の段が表を持つ「一覧の面」なので、版面は広い側を使う（Issue #485）。
    // 段ごとに幅を切り替えると段の移動のたびに見出しと段階表示が横へ跳ぶので、ウィザード全体で 1 つの幅にする。
    // フォームの欄の幅は Field の sm:max-w-xs で留める（招待コード・利用者管理と同じ組み方）。
    // 既存の main を **置換** する（入れ子にすると主要領域が 2 つになる）。
    <PageShell width="lg" className="flex flex-col gap-6">
      <Heading level={1}>店舗登録</Heading>

      <WizardProgress current={step} />

      {isOperator && agencies.kind === 'error' && step === 'owner' && (
        <Alert variant="destructive">
          <AlertDescription>{AGENCY_LOAD_ERROR_TEXT}</AlertDescription>
        </Alert>
      )}

      {step === 'owner' && (
        <section className="flex flex-col gap-4">
          <Heading level={2} ref={stepHeadingRef} tabIndex={-1}>
            オーナー選択
          </Heading>

          {!isOperator && (
            <OwnerRoster
              state={rosters.get(SELF_ROSTER_KEY)}
              tableLabel="オーナー一覧"
              onRetry={() => retryRoster(SELF_ROSTER_KEY, undefined)}
              onRetryStores={() => void retryStores(SELF_ROSTER_KEY, undefined)}
              onSelect={(owner) => handleSelectOwner(owner, null)}
            />
          )}

          {isOperator && agencies.kind === 'loading' && <LoadingLine />}

          {isOperator && agencies.kind === 'loaded' && agencies.agencies.length === 0 && (
            <p>代理店が登録されていません。先に代理店管理で代理店を登録してください。</p>
          )}

          {isOperator && agencies.kind === 'loaded' && agencies.agencies.length > 0 && (
            <div className="flex flex-col gap-3">
              {agencies.agencies.map((agency) => (
                // 開閉はネイティブの要素に任せる（キーボード操作と開閉状態の読み上げが標準で付く）。
                // **name 属性は付けない。** 排他にすると代理店を見比べられない（背景 1 の課題）。
                <details
                  key={agency.id}
                  open={openAgencyIds.has(agency.id)}
                  onToggle={(event) => handleAgencyToggle(agency.id, event.currentTarget.open)}
                >
                  {/* summary 自体がボタンとして振る舞うので、中には代理店名の文字列だけを置く。
                    * 押しボタン・リンク・見出しを入れると焦点が壊れる。開閉の三角（マーカー）は消さない。 */}
                  <summary className="cursor-pointer py-2 font-semibold">{agency.name}</summary>
                  {openAgencyIds.has(agency.id) && (
                    <div className="pt-2 pb-4">
                      <OwnerRoster
                        state={rosters.get(agency.id)}
                        tableLabel={`${agency.name} のオーナー`}
                        onRetry={() => retryRoster(agency.id, agency.id)}
                        onRetryStores={() => void retryStores(agency.id, agency.id)}
                        onSelect={(owner) => handleSelectOwner(owner, agency)}
                      />
                    </div>
                  )}
                </details>
              ))}
            </div>
          )}
        </section>
      )}

      {step === 'search' && selected !== null && (
        <section className="flex flex-col gap-4">
          <Heading level={2} ref={stepHeadingRef} tabIndex={-1}>
            店名検索
          </Heading>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* 横並びの子は既定で中身の最小幅より縮まない。文節で改行する規則（正典 §6）のもとでは、
              * 長い代理店名（カタカナの複合語は 1 文節）がその最小幅になり、狭い画面で面を押し広げる
              * （CI の字幅で 320px 幅のとき右端 400px まで伸びた）。min-w-0 で縮め、入りきらない文節だけを
              * 非常時の折り返しに任せる。 */}
            <p className="min-w-0">{ownerTargetText(selected)}</p>
            {/* 戻っても一覧と開いていた区画はそのまま（取り直さない）。状態はウィザードの側にある。 */}
            <Button type="button" variant="outline" onClick={() => goToStep('owner')}>
              オーナーを選び直す
            </Button>
          </div>

          {/* 検索の帯。記入欄と押しボタンを 1 本の横並びの箱へ収める。
            * 面は共通部品（カード）から来るので、面の側は塗りも角丸も持たない。
            * **輪郭を打ち消すユーティリティは書かない。** フォーカス指標は theme.css の
            * base 層に一本化されており、面の側で打ち消すとレイヤ順により必ず勝つ（Issue #49）。 */}
          <Card>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <FieldGroup className="contents">
                <Field className="min-w-0 flex-1">
                  <FieldLabel htmlFor="store-name-input">店名</FieldLabel>
                  <Input
                    id="store-name-input"
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </Field>
              </FieldGroup>
              <Button
                type="button"
                className="self-start sm:self-auto"
                disabled={query.trim() === '' || search.kind === 'searching'}
                onClick={() => void handleSearch()}
                aria-busy={search.kind === 'searching'}
              >
                {search.kind === 'searching' && <Spinner aria-hidden />}
                検索
              </Button>
            </CardContent>
          </Card>

          {search.kind === 'empty' && (
            <Alert variant="destructive">
              <AlertDescription>見つかりませんでした。表記を変えて再検索してください。</AlertDescription>
            </Alert>
          )}
          {search.kind === 'error' && (
            <Alert variant="destructive">
              <AlertDescription>検索に失敗しました。時間をおいて再試行してください。</AlertDescription>
            </Alert>
          )}
          {allRegistered && (
            // 失敗ではなく案内なので危険の変種にしない（既定の変種は読み上げ役割 status を持つ）。
            <Alert>
              <AlertDescription>
                見つかった店舗はすべて登録済みです。店名の表記を変えて検索するか、
                <Link href="/stores">店舗一覧</Link>
                で確認してください。
              </AlertDescription>
            </Alert>
          )}
          {search.kind === 'found' && (
            <ul role="list" className="flex flex-col gap-2">
              {search.results.map(({ candidate: item, alreadyRegistered }) => (
                <li key={item.placeId}>
                  {alreadyRegistered ? (
                    <RegisteredCandidate candidate={item} />
                  ) : (
                    // 未登録の候補は押しボタンのまま（役割を変えない・Req 3.3）。
                    // 借りるのは「題名・補足・右端の指示子」というメタの積み方だけである。
                    // **写真プレートを前提にしたカードは真似しない**（正典 §7.6）。店舗検索の
                    // 応答に写真は含まれず、写真なしで真似ると空の矩形が並ぶだけで劣化する。
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto w-full justify-between gap-3 py-3 text-left"
                      // 読み上げ名を意匠の変更前と **byte 一致** で固定する（Req 3.2）。
                      //
                      // 題名と補足を縦に積むと、両者は横並びの箱の要素になって display が
                      // ブロック化する。読み上げ名の算出はブロック化した子の前後へ区切りの空白を
                      // 入れるため、名前が `店名 （住所）` へ静かに変わる（実測で確認した）。
                      // ここで元の連結をそのまま与えることで、見た目だけを積み直して名前は動かさない。
                      aria-label={`${item.name}（${item.address}）`}
                      onClick={() => {
                        setCandidate(item);
                        goToStep('confirm');
                      }}
                    >
                      <span className="flex min-w-0 flex-col items-start gap-0.5">
                        <span className="w-full truncate">{item.name}</span>
                        <span className="w-full truncate text-xs">（{item.address}）</span>
                      </span>
                      {/* 右端の指示子は装飾である。読み上げ名は題名と補足だけで構成される。 */}
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {step === 'confirm' && candidate !== null && selected !== null && (
        <section className="flex flex-col gap-4">
          <Heading level={2} ref={stepHeadingRef} tabIndex={-1}>
            店舗の確認
          </Heading>
          <p>{ownerTargetText(selected)}</p>
          <p>店名: {candidate.name}</p>
          <p>住所: {candidate.address}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => goToStep('search')}>
              店名検索へ戻る
            </Button>
            <Button type="button" onClick={() => goToStep('basic')}>
              この店舗で進む
            </Button>
          </div>
        </section>
      )}

      {step === 'basic' && candidate !== null && selected !== null && (
        <section className="flex flex-col gap-4">
          <Heading level={2} ref={stepHeadingRef} tabIndex={-1}>
            基本情報
          </Heading>
          <p>{ownerTargetText(selected)}</p>
          <p>店名: {candidate.name}</p>
          <p>住所: {candidate.address}</p>
          {/* 幅の段は招待コード・代理店管理・利用者管理と同一である
            * （Req 1.2。面をまたいだ一致は admin-users-page.test.tsx がソースから照合する）。 */}
          <FieldGroup>
            <Field className="sm:max-w-xs">
              <FieldLabel htmlFor="category-select">カテゴリ（任意）</FieldLabel>
              <Select
                id="category-select"
                value={categoryCode}
                onChange={(event) => setCategoryCode(event.target.value)}
              >
                <option value="">未選択</option>
                {categories.map((category) => (
                  <option key={category.code} value={category.code}>
                    {category.label}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldGroup>
          <Button
            type="button"
            className="self-start"
            disabled={submit.kind === 'submitting'}
            onClick={() => void handleConfirm()}
            aria-busy={submit.kind === 'submitting'}
          >
            {submit.kind === 'submitting' && <Spinner aria-hidden />}
            登録を確定
          </Button>

          {submit.kind === 'conflict' && (
            <Alert variant="destructive">
              <AlertDescription>既に登録済みの店舗です。</AlertDescription>
            </Alert>
          )}
          {submit.kind === 'forbidden' && (
            <Alert variant="destructive">
              <AlertDescription>
                この操作を行う権限がありません。運営までお問い合わせください。
              </AlertDescription>
            </Alert>
          )}
          {submit.kind === 'error' && (
            <Alert variant="destructive">
              <AlertDescription>
                店舗を登録できませんでした。時間をおいてもう一度お試しください。
              </AlertDescription>
            </Alert>
          )}
        </section>
      )}

      {step === 'done' && (
        <section className="flex flex-col gap-4">
          <Heading level={2} ref={stepHeadingRef} tabIndex={-1}>
            登録が完了しました
          </Heading>
          <p>店舗を登録しました。</p>
          <Link href="/stores">店舗一覧へ戻る</Link>
        </section>
      )}
    </PageShell>
  );
}

// 店舗登録ウィザード。認可ガードで囲い、共通ナビを添える。全文言日本語（Req 7.3）。
export default function StoreRegisterPage() {
  return (
    <AuthGuard>
      <TopNav />
      <RegisterWizard />
    </AuthGuard>
  );
}

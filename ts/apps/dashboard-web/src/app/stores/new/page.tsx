'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { Card, CardContent } from '@fwlm/ui/components/card';
import { Heading } from '@fwlm/ui/components/heading';
import { Input } from '@fwlm/ui/components/input';
import { Label } from '@fwlm/ui/components/label';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { Select } from '@fwlm/ui/components/select';
import { Spinner } from '@fwlm/ui/components/spinner';
import { AuthGuard } from '../../../components/auth-guard';
import { TopNav } from '../../../components/top-nav';
import { useAuth } from '../../../lib/auth-context';
import { getAgencies, getCategories, getOwners, registerStore, searchStores } from '../../../lib/api';
import type { AgencyItem, Category, OwnerListItem, StoreCandidate } from '../../../lib/types';

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
type SearchState =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'found'; candidates: StoreCandidate[] }
  | { kind: 'empty' }
  | { kind: 'error' };

// 確定送信の結果（成功・既登録・権限外・その他障害）。
type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success' }
  | { kind: 'conflict' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string };

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

function RegisterWizard() {
  const { me } = useAuth();
  const isOperator = me?.role === 'operator';

  // オーナー解決に必要な状態。operator は代理店選択が先行する。
  const [agencies, setAgencies] = useState<AgencyItem[] | null>(null);
  const [selectedAgencyId, setSelectedAgencyId] = useState('');
  const [owners, setOwners] = useState<OwnerListItem[] | null>(null);
  const [ownersLoaded, setOwnersLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedOwnerId, setSelectedOwnerId] = useState('');
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

  // operator: 代理店一覧を読み込む（agency は自代理店固定のため不要）。
  useEffect(() => {
    if (!isOperator) return;
    let active = true;
    void (async () => {
      const result = await getAgencies();
      if (!active) return;
      if (result.ok) setAgencies(result.value);
      else setLoadError(result.message);
    })();
    return () => {
      active = false;
    };
  }, [isOperator]);

  // agency: 自代理店のオーナーを読み込む。
  useEffect(() => {
    if (isOperator) return;
    let active = true;
    void (async () => {
      const result = await getOwners({});
      if (!active) return;
      setOwnersLoaded(true);
      if (result.ok) setOwners(result.value);
      else setLoadError(result.message);
    })();
    return () => {
      active = false;
    };
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

  // operator が代理店を選び直したら、その代理店のオーナーを取り直す。
  function handleSelectAgency(agencyId: string) {
    setSelectedAgencyId(agencyId);
    setOwners(null);
    setOwnersLoaded(false);
    setSelectedOwnerId('');
    setLoadError(null);
    if (agencyId === '') return;
    void (async () => {
      const result = await getOwners({ agencyId });
      setOwnersLoaded(true);
      if (result.ok) setOwners(result.value);
      else setLoadError(result.message);
    })();
  }

  async function handleSearch() {
    const trimmed = query.trim();
    if (trimmed === '') return;
    setSearch({ kind: 'searching' });
    const result = await searchStores(trimmed);
    if (result.ok) {
      // 候補は最大10件（サーバー保証だが UI 側でも切り詰める）。
      const candidates = result.value.slice(0, 10);
      setSearch(candidates.length === 0 ? { kind: 'empty' } : { kind: 'found', candidates });
    } else {
      setSearch({ kind: 'error' });
    }
  }

  async function handleConfirm() {
    if (candidate === null || selectedOwnerId === '') return;
    setSubmit({ kind: 'submitting' });
    const result = await registerStore({
      ownerId: selectedOwnerId,
      candidate,
      categoryCode: categoryCode === '' ? undefined : categoryCode,
    });
    if (result.ok) {
      setSubmit({ kind: 'success' });
      setStep('done');
    } else if (result.code === 'place_already_registered') {
      setSubmit({ kind: 'conflict' });
    } else if (result.code === 'forbidden') {
      setSubmit({ kind: 'forbidden' });
    } else {
      setSubmit({ kind: 'error', message: result.message });
    }
  }

  const hasOwners = owners !== null && owners.length > 0;
  const noOwners = ownersLoaded && owners !== null && owners.length === 0;

  return (
    // ウィザードのフォームが主体であり一覧ではないので、版面は本文系（狭い側）を使う。
    // 既存の main を **置換** する（入れ子にすると主要領域が 2 つになる）。
    <PageShell width="sm" className="flex flex-col gap-6">
      <Heading level={1}>店舗登録</Heading>

      <WizardProgress current={step} />

      {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねると
        * 読み上げ領域が二重になるため、文言は説明の受け口へ置くだけにする。 */}
      {loadError !== null && step === 'owner' && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      {step === 'owner' && (
        <section className="flex flex-col gap-4">
          <Heading level={2}>オーナー選択</Heading>

          {isOperator && (
            // **段落ではなく汎用の容器で包む。** 選択の部品は開閉の記号を重ねるために div を
            // 1 枚挟むので、段落の直下には置けない（置くとブラウザの構文解析が段落を早期に
            // 閉じ、サーバ描画とクライアント描画の木が食い違う）。
            // 幅の段は task 2.4 / 2.5 が招待コード・代理店管理・利用者管理で採ったものと同一である
            // （Req 1.2。面をまたいだ一致は admin-users-page.test.tsx がソースから照合する）。
            <div className="flex flex-col gap-2 sm:max-w-xs">
              <Label htmlFor="agency-select">代理店</Label>
              {/* 標準の選択要素のラッパである。id・value・onChange はいずれも選択要素へ透過し、
                * ラベルとの関連付けもプログラムによる値の変更もそのまま働く（Req 3.4）。 */}
              <Select
                id="agency-select"
                value={selectedAgencyId}
                onChange={(event) => handleSelectAgency(event.target.value)}
              >
                <option value="">代理店を選択してください</option>
                {(agencies ?? []).map((agency) => (
                  <option key={agency.id} value={agency.id}>
                    {agency.name}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {/* 選択可能オーナーが 0 件のとき、招待コード先行の必要を案内する（Req 3.3） */}
          {noOwners && (
            <Alert variant="destructive">
              <AlertDescription>
                対象オーナーがいません。オーナーが先に LINE で招待コード入力を済ませる必要があります。
              </AlertDescription>
            </Alert>
          )}

          {hasOwners && (
            <>
              <div className="flex flex-col gap-2 sm:max-w-xs">
                <Label htmlFor="owner-select">オーナー</Label>
                <Select
                  id="owner-select"
                  value={selectedOwnerId}
                  onChange={(event) => setSelectedOwnerId(event.target.value)}
                >
                  <option value="">オーナーを選択してください</option>
                  {(owners ?? []).map((owner) => (
                    <option key={owner.id} value={owner.id}>
                      {owner.displayName ?? owner.id}
                    </option>
                  ))}
                </Select>
              </div>
              {/* 版面は縦の flex なので、そのまま置くと押しボタンが行幅いっぱいに伸びる。
                * 主操作を全幅にするのはログイン画面の判断（正典 §7.9）であってこの面の判断ではない。
                * 無効の通知手段は変えない（素の無効属性のまま・Req 3.5）。 */}
              <Button
                type="button"
                className="self-start"
                disabled={selectedOwnerId === ''}
                onClick={() => setStep('search')}
              >
                次へ（店名検索）
              </Button>
            </>
          )}

          {!isOperator && !ownersLoaded && loadError === null && (
            // Spinner 自身も role="status" を持つため、読み上げはこの行に一本化する。
            // 図形は装飾として扱い aria-hidden で支援技術から外す。文言は可視のテキストのまま
            // 残す（Spinner の aria-label へ移すと sr-only の子要素へ落ちる・Req 4.5）。
            <p role="status" className="flex items-center gap-2">
              <Spinner aria-hidden />
              読み込み中...
            </p>
          )}
        </section>
      )}

      {step === 'search' && (
        <section className="flex flex-col gap-4">
          <Heading level={2}>店名検索</Heading>

          {/* 検索の帯。記入欄と押しボタンを 1 本の横並びの箱へ収める。
            * 面は共通部品（カード）から来るので、面の側は塗りも角丸も持たない。
            * **輪郭を打ち消すユーティリティは書かない。** フォーカス指標は theme.css の
            * base 層に一本化されており、面の側で打ち消すとレイヤ順により必ず勝つ（Issue #49）。 */}
          <Card>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Label htmlFor="store-name-input">店名</Label>
                <Input
                  id="store-name-input"
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Button
                type="button"
                className="self-start sm:self-auto"
                disabled={query.trim() === '' || search.kind === 'searching'}
                onClick={() => void handleSearch()}
              >
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
          {search.kind === 'found' && (
            <ul className="flex flex-col gap-2">
              {search.candidates.map((item) => (
                <li key={item.placeId}>
                  {/* 候補は押しボタンのまま（役割も個数も変えない・Req 3.3）。
                    * 借りるのは「題名・補足・右端の指示子」というメタの積み方だけである。
                    * **写真プレートを前提にしたカードは真似しない**（正典 §7.6）。店舗検索の
                    * 応答に写真は含まれず、写真なしで真似ると空の矩形が並ぶだけで劣化する。 */}
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
                      setStep('confirm');
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
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {step === 'confirm' && candidate !== null && (
        <section className="flex flex-col gap-4">
          <Heading level={2}>店舗の確認</Heading>
          <p>店名: {candidate.name}</p>
          <p>住所: {candidate.address}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => setStep('search')}>
              店名検索へ戻る
            </Button>
            <Button type="button" onClick={() => setStep('basic')}>
              この店舗で進む
            </Button>
          </div>
        </section>
      )}

      {step === 'basic' && candidate !== null && (
        <section className="flex flex-col gap-4">
          <Heading level={2}>基本情報</Heading>
          <p>店名: {candidate.name}</p>
          <p>住所: {candidate.address}</p>
          <div className="flex flex-col gap-2 sm:max-w-xs">
            <Label htmlFor="category-select">カテゴリ（任意）</Label>
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
          </div>
          <Button
            type="button"
            className="self-start"
            disabled={submit.kind === 'submitting'}
            onClick={() => void handleConfirm()}
          >
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
              <AlertDescription>{submit.message}</AlertDescription>
            </Alert>
          )}
        </section>
      )}

      {step === 'done' && (
        <section className="flex flex-col gap-4">
          <Heading level={2}>登録が完了しました</Heading>
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

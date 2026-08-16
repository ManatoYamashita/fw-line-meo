'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGuard } from '../../../components/auth-guard';
import { TopNav } from '../../../components/top-nav';
import { useAuth } from '../../../lib/auth-context';
import { getAgencies, getCategories, getOwners, registerStore, searchStores } from '../../../lib/api';
import type { AgencyItem, Category, OwnerListItem, StoreCandidate } from '../../../lib/types';

// ウィザードの段階。オーナー選択 → 店名検索 → 候補確認 → 基本情報 → 完了。
type Step = 'owner' | 'search' | 'confirm' | 'basic' | 'done';

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
    <main>
      <h1>店舗登録</h1>

      {loadError !== null && step === 'owner' && <p role="alert">{loadError}</p>}

      {step === 'owner' && (
        <section>
          <h2>オーナー選択</h2>

          {isOperator && (
            <p>
              <label htmlFor="agency-select">代理店</label>
              <select
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
              </select>
            </p>
          )}

          {/* 選択可能オーナーが 0 件のとき、招待コード先行の必要を案内する（Req 3.3） */}
          {noOwners && (
            <p role="alert">
              対象オーナーがいません。オーナーが先に LINE で招待コード入力を済ませる必要があります。
            </p>
          )}

          {hasOwners && (
            <>
              <p>
                <label htmlFor="owner-select">オーナー</label>
                <select
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
                </select>
              </p>
              <button
                type="button"
                disabled={selectedOwnerId === ''}
                onClick={() => setStep('search')}
              >
                次へ（店名検索）
              </button>
            </>
          )}

          {!isOperator && !ownersLoaded && loadError === null && <p>読み込み中...</p>}
        </section>
      )}

      {step === 'search' && (
        <section>
          <h2>店名検索</h2>
          <p>
            <label htmlFor="store-name-input">店名</label>
            <input
              id="store-name-input"
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </p>
          <button
            type="button"
            disabled={query.trim() === '' || search.kind === 'searching'}
            onClick={() => void handleSearch()}
          >
            検索
          </button>

          {search.kind === 'empty' && (
            <p role="alert">見つかりませんでした。表記を変えて再検索してください。</p>
          )}
          {search.kind === 'error' && (
            <p role="alert">検索に失敗しました。時間をおいて再試行してください。</p>
          )}
          {search.kind === 'found' && (
            <ul>
              {search.candidates.map((item) => (
                <li key={item.placeId}>
                  <button
                    type="button"
                    onClick={() => {
                      setCandidate(item);
                      setStep('confirm');
                    }}
                  >
                    {item.name}（{item.address}）
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {step === 'confirm' && candidate !== null && (
        <section>
          <h2>店舗の確認</h2>
          <p>店名: {candidate.name}</p>
          <p>住所: {candidate.address}</p>
          <button type="button" onClick={() => setStep('search')}>
            店名検索へ戻る
          </button>
          <button type="button" onClick={() => setStep('basic')}>
            この店舗で進む
          </button>
        </section>
      )}

      {step === 'basic' && candidate !== null && (
        <section>
          <h2>基本情報</h2>
          <p>店名: {candidate.name}</p>
          <p>住所: {candidate.address}</p>
          <p>
            <label htmlFor="category-select">カテゴリ（任意）</label>
            <select
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
            </select>
          </p>
          <button type="button" disabled={submit.kind === 'submitting'} onClick={() => void handleConfirm()}>
            登録を確定
          </button>

          {submit.kind === 'conflict' && <p role="alert">既に登録済みの店舗です。</p>}
          {submit.kind === 'forbidden' && (
            <p role="alert">この操作を行う権限がありません。運営までお問い合わせください。</p>
          )}
          {submit.kind === 'error' && <p role="alert">{submit.message}</p>}
        </section>
      )}

      {step === 'done' && (
        <section>
          <h2>登録が完了しました</h2>
          <p>店舗を登録しました。</p>
          <Link href="/stores">店舗一覧へ戻る</Link>
        </section>
      )}
    </main>
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

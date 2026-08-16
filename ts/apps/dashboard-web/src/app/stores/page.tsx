'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGuard } from '../../components/auth-guard';
import { TopNav } from '../../components/top-nav';
import { useAuth } from '../../lib/auth-context';
import { getStores } from '../../lib/api';
import type { StoreListItem } from '../../lib/types';

// 店舗一覧の取得状態。ローディング/エラー/取得済みを判別共用体で表す（7.4: 失敗時にデータを偽装しない）。
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; stores: StoreListItem[] };

// 店舗一覧本体。AuthGuard 配下でのみ描画されるため me は非 null 前提だが、防御的に optional 参照する。
function StoresView() {
  const { me } = useAuth();
  const isOperator = me?.role === 'operator';
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    void (async () => {
      // agency は自代理店分・operator は全件（agencyId 未指定）。トークン付与は api クライアント既定に委譲。
      const result = await getStores({});
      if (!active) return;
      if (result.ok) {
        setState({ kind: 'ready', stores: result.value });
      } else {
        setState({ kind: 'error', message: result.message });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <main>
      <h1>店舗一覧</h1>
      {state.kind === 'loading' && <p>読み込み中...</p>}
      {state.kind === 'error' && <p role="alert">{state.message}</p>}
      {state.kind === 'ready' && state.stores.length === 0 && (
        <div>
          <p>担当店舗は 0件 です。</p>
          <Link href="/stores/new">店舗を登録する</Link>
        </div>
      )}
      {state.kind === 'ready' && state.stores.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>店名</th>
              <th>店舗特定</th>
              <th>競合設定</th>
              {/* operator は全店舗を担当代理店が識別できる形で見る（Req 4.2） */}
              {isOperator && <th>担当代理店</th>}
            </tr>
          </thead>
          <tbody>
            {state.stores.map((store) => (
              <tr key={store.id}>
                <td>{store.name}</td>
                {/* 店舗特定バッジ（Req 4.3） */}
                <td>{store.placeStatus === 'confirmed' ? '確定済み' : '未確定'}</td>
                {/* 競合設定バッジ（Req 4.3・変更手段は提供しない = 表示のみ Req 4.5） */}
                <td>{store.competitorConfigured ? '競合設定済み' : '競合未設定'}</td>
                {isOperator && <td>{store.agencyName}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

// ログイン後の既定ランディング。認可ガードで囲い、共通ナビを添える。全文言日本語（Req 7.3）。
export default function StoresPage() {
  return (
    <AuthGuard>
      <TopNav />
      <StoresView />
    </AuthGuard>
  );
}

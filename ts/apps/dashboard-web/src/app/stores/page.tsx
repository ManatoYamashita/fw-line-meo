'use client';

import { Fragment, useEffect, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { Button } from '@fwlm/ui/components/button';
import { AuthGuard } from '../../components/auth-guard';
import { StoreQrPanel } from '../../components/store-qr-panel';
import { TopNav } from '../../components/top-nav';
import { useAuth } from '../../lib/auth-context';
import { getStores } from '../../lib/api';
import type { StoreListItem } from '../../lib/types';

// 店舗一覧の取得状態。ローディング/エラー/取得済みを判別共用体で表す（7.4: 失敗時にデータを偽装しない）。
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; stores: StoreListItem[] };

// 全ロール共通の列数（店名・店舗特定・競合設定・QR）。operator のみ担当代理店列が加わる。
// パネル行の colSpan はここからロールに応じて算出する。ロール差分を各所へ散らさないための
// 単一の起点であり、下の <th> の並びとは別に列数を持つ点は残っている
// （operator / agency 双方の colSpan をテストで固定してドリフトを検出する）。
const BASE_COLUMN_COUNT = 4;

// 発行操作から開閉先のパネルを指すための id（aria-controls 用）。
function panelId(storeId: string): string {
  return `qr-panel-${storeId}`;
}

// 店舗一覧本体。AuthGuard 配下でのみ描画されるため me は非 null 前提だが、防御的に optional 参照する。
function StoresView() {
  const { me } = useAuth();
  const isOperator = me?.role === 'operator';
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  // QR パネルを開いている店舗。開閉状態は一覧が所有し、パネル自身は持たない。
  const [openStoreId, setOpenStoreId] = useState<string | null>(null);
  const columnCount = BASE_COLUMN_COUNT + (isOperator ? 1 : 0);
  // 直近に押された発行操作。パネルを閉じると焦点の載っていた要素ごと消えるため、
  // 焦点を呼び出し元へ戻す（戻さないと body へ落ち、焦点位置が視覚的に判別できなくなる）。
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  function openPanel(event: MouseEvent<HTMLButtonElement>, storeId: string) {
    triggerRef.current = event.currentTarget;
    setOpenStoreId(storeId);
  }

  function closePanel() {
    // 対象は消えないので先に焦点を移してよい（この後の再描画でパネルだけが外れる）。
    triggerRef.current?.focus();
    setOpenStoreId(null);
  }

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
              {/* 店頭設置用 QR の発行導線（store-qr-issuance-ui Req 1.1） */}
              <th>QR</th>
            </tr>
          </thead>
          <tbody>
            {state.stores.map((store) => (
              <Fragment key={store.id}>
                <tr>
                  <td>{store.name}</td>
                  {/* 店舗特定バッジ（Req 4.3） */}
                  <td>{store.placeStatus === 'confirmed' ? '確定済み' : '未確定'}</td>
                  {/* 競合設定バッジ（Req 4.3・変更手段は提供しない = 表示のみ Req 4.5） */}
                  <td>{store.competitorConfigured ? '競合設定済み' : '競合未設定'}</td>
                  {isOperator && <td>{store.agencyName}</td>}
                  <td>
                    {/* 分岐条件は場所の状態のみ。競合設定の状態を条件に含めない（Req 1.5）。 */}
                    {store.placeStatus === 'confirmed' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(event) => openPanel(event, store.id)}
                        aria-expanded={openStoreId === store.id}
                        aria-controls={openStoreId === store.id ? panelId(store.id) : undefined}
                        // 見えている文言（QR 発行）を読み上げ名へそのまま含める。含めないと
                        // 音声入力の利用者が見えているとおりに発話しても操作できない
                        // （WCAG 2.5.3 Label in Name）。
                        aria-label={`${store.name} の QR 発行`}
                      >
                        QR 発行
                      </Button>
                    ) : (
                      // 発行操作に代えて理由を同じ位置に置く（Req 3.1, 3.2）。
                      <span className="text-muted-foreground">場所の確定が必要です</span>
                    )}
                  </td>
                </tr>
                {openStoreId === store.id && (
                  // 対象行の直下へ挿入し、対応関係を視覚的にも DOM 順でも読み取れるようにする。
                  <tr>
                    <td colSpan={columnCount} id={panelId(store.id)}>
                      {/* fetchQr は渡さない。インライン関数を渡すと参照が毎描画で変わり、
                        * パネル側の副作用が再走して取得が繰り返される（Req 2.2, 2.3 が同時に壊れる）。 */}
                      <StoreQrPanel
                        key={store.id}
                        storeId={store.id}
                        storeName={store.name}
                        onClose={closePanel}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
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

'use client';

import { Fragment, useEffect, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button, buttonVariants } from '@fwlm/ui/components/button';
import { EmptyState } from '@fwlm/ui/components/empty-state';
import { Heading } from '@fwlm/ui/components/heading';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { Spinner } from '@fwlm/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@fwlm/ui/components/table';
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
// 単一の起点であり、下の見出しセルの並びとは別に列数を持つ点は残っている
// （operator / agency 双方の colSpan をテストで固定してドリフトを検出する。さらに
// 「桁数と列見出しの実数が一致する」ことも照合して、2 つの起点を検証側で結び付けてある）。
const BASE_COLUMN_COUNT = 4;

// 発行操作から開閉先のパネルを指すための id（aria-controls 用）。
function panelId(storeId: string): string {
  return `qr-panel-${storeId}`;
}

// 店舗一覧本体。AuthGuard 配下でのみ描画されるため me は非 null 前提だが、防御的に optional 参照する。
//
// 版面・一覧・空状態・通知・処理中はいずれも共通部品を通す（design.md の Architecture Pattern が
// 定める置換。面ごとの意匠アダプタを作らない）。表を表のまま装飾する判断・行区切りを 1px の罫線
// だけにする判断・行の重畳時に面を塗らない判断は docs/design/design-language.md の 7.2 節が正典で、
// ここでは結論も数値も転記せず参照する。
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
    // 一覧が主の面なので版面は広い側を使う。既存の main を **置換** する（入れ子にしない）。
    <PageShell width="lg" className="flex flex-col gap-6">
      <Heading level={1}>店舗一覧</Heading>
      {state.kind === 'loading' && (
        // Spinner 自身も role="status" を持つため、読み上げはこの行に一本化する。
        // 図形は装飾として扱い aria-hidden で支援技術から外す。文言は可視のテキストのまま残す
        // （Spinner の aria-label へ移すと sr-only の子要素へ落ちる・Req 4.5）。
        <p role="status" className="flex items-center gap-2">
          <Spinner aria-hidden />
          読み込み中...
        </p>
      )}
      {state.kind === 'error' && (
        // 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねると
        // 領域が二重になるため、文言は説明の受け口へ置くだけにする。
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      {state.kind === 'ready' && state.stores.length === 0 && (
        // 空状態の部品は押しボタンを内包しない。次に取れる操作への導線（Req 2.3）は
        // 呼び出し側が children として渡す。要素はリンクのまま、見た目だけを借りる
        // （store-qr-panel.tsx の保存リンクと同じ作法）。
        <EmptyState>
          <p>担当店舗は 0件 です。</p>
          <Link href="/stores/new" className={buttonVariants()}>
            店舗を登録する
          </Link>
        </EmptyState>
      )}
      {state.kind === 'ready' && state.stores.length > 0 && (
        // 横方向の捲りは表の **外側** が持つ。tbody の内側へ挟むと行の隣接関係が壊れ、
        // 発行パネルを対象行の直後へ挿す構成が成立しなくなる。
        // この容器は e2e（dashboard-surfaces.spec.ts）が宣言する「表の捲れる領域 1 件」である。
        <TableContainer label="店舗一覧">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>店名</TableHeaderCell>
                <TableHeaderCell>店舗特定</TableHeaderCell>
                <TableHeaderCell>競合設定</TableHeaderCell>
                {/* operator は全店舗を担当代理店が識別できる形で見る（Req 4.2） */}
                {isOperator && <TableHeaderCell>担当代理店</TableHeaderCell>}
                {/* 店頭設置用 QR の発行導線（store-qr-issuance-ui Req 1.1） */}
                <TableHeaderCell>QR</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {state.stores.map((store) => (
                <Fragment key={store.id}>
                  <TableRow>
                    <TableCell>{store.name}</TableCell>
                    {/* 店舗特定バッジ（Req 4.3） */}
                    <TableCell>{store.placeStatus === 'confirmed' ? '確定済み' : '未確定'}</TableCell>
                    {/* 競合設定バッジ（Req 4.3・変更手段は提供しない = 表示のみ Req 4.5） */}
                    <TableCell>
                      {store.competitorConfigured ? '競合設定済み' : '競合未設定'}
                    </TableCell>
                    {isOperator && <TableCell>{store.agencyName}</TableCell>}
                    <TableCell>
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
                        // 補足色は着手前から置かれており、その組（補足色 × ページ背景）は
                        // docs/design/design-language.md の 2.2 節に既にある。色を増やさない。
                        <span className="text-muted-foreground">場所の確定が必要です</span>
                      )}
                    </TableCell>
                  </TableRow>
                  {openStoreId === store.id && (
                    // 対象行の直下へ挿入し、対応関係を視覚的にも DOM 順でも読み取れるようにする。
                    <TableRow>
                      <TableCell colSpan={columnCount} id={panelId(store.id)}>
                        {/* fetchQr は渡さない。インライン関数を渡すと参照が毎描画で変わり、
                          * パネル側の副作用が再走して取得が繰り返される（Req 2.2, 2.3 が同時に壊れる）。 */}
                        <StoreQrPanel
                          key={store.id}
                          storeId={store.id}
                          storeName={store.name}
                          onClose={closePanel}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </PageShell>
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

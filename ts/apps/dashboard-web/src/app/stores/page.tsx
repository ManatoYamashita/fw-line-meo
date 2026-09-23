'use client';

import { Fragment, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button, buttonVariants } from '@fwlm/ui/components/button';
import { cn } from '@fwlm/ui/lib/utils';
import { EmptyState } from '@fwlm/ui/components/empty-state';
import { Heading } from '@fwlm/ui/components/heading';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { Spinner } from '@fwlm/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableDetailRow,
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
import { StoreSuspensionControl } from './store-suspension-control';

// 店舗一覧の取得状態。ローディング/エラー/取得済みを判別共用体で表す（7.4: 失敗時にデータを偽装しない）。
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; stores: StoreListItem[] };

// 全ロール共通の列数（店名・店舗特定・競合設定・利用状況・QR）。operator のみ担当代理店列が加わる。
// パネル行の colSpan はここからロールに応じて算出する。ロール差分を各所へ散らさないための
// 単一の起点であり、下の見出しセルの並びとは別に列数を持つ点は残っている
// （operator / agency 双方の colSpan をテストで固定してドリフトを検出する。さらに
// 「桁数と列見出しの実数が一致する」ことも照合して、2 つの起点を検証側で結び付けてある）。
const BASE_COLUMN_COUNT = 5;

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
  // 停止・再開の後の読み直しに失敗したときの文言。表は古い表示のまま残し、失敗だけを別に示す。
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // 読み直しの要求の通し番号。続けて操作されたとき、先に出した要求の応答が後から届いて
  // 新しい表示を古い一覧で上書きしないよう、最後の要求の応答だけを採る。
  const refreshSeq = useRef(0);
  // 画面を離れた後に届いた応答で state を書かないための印（初回取得の active と同じ役割）。
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function openPanel(event: MouseEvent<HTMLButtonElement>, storeId: string) {
    triggerRef.current = event.currentTarget;
    setOpenStoreId(storeId);
  }

  function closePanel() {
    // 対象は消えないので先に焦点を移してよい（この後の再描画でパネルだけが外れる）。
    triggerRef.current?.focus();
    setOpenStoreId(null);
  }

  // 停止・再開の後の読み直し（store-suspension Requirement 2.4）。
  //
  // **表を読み込み中の表示へ置き換えない。** 置き換えると行ごと外れ、押した操作部品の焦点と
  // 成功を告げるライブリージョンが失われる（焦点は文書の先頭へ落ち、通知は読み上げられない）。
  // 取得の間は表を描いたまま待ち、応答が来たら行の中身だけを差し替える。行は店舗 ID を key に
  // 持つので、同じ店舗の行と操作部品は同じ要素のまま残る。
  const refreshStores = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const result = await getStores({});
    if (!mounted.current || seq !== refreshSeq.current) return;
    if (!result.ok) {
      setRefreshError(result.message);
      return;
    }
    setRefreshError(null);
    setState({ kind: 'ready', stores: result.value });
    // 停止された店舗の QR パネルは閉じる。停止前に発行した画像と保存の導線を残すと、
    // 停止中の店舗の QR を店頭へ出せてしまう（Requirement 5.6）。押した焦点は利用状況の列の
    // 操作部品にあり、パネルの中には無いので、焦点は動かさずに外すだけにする。
    setOpenStoreId((current) => {
      if (current === null) return current;
      const opened = result.value.find((store) => store.id === current);
      return opened !== undefined && opened.suspendedAt === null ? current : null;
    });
  }, []);

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
      {refreshError !== null && state.kind === 'ready' && (
        // 読み直しの失敗。表は外さず、その上に示す（危険の変種は自ら role="alert" を持つ）。
        <Alert variant="destructive">
          <AlertDescription>{refreshError}</AlertDescription>
        </Alert>
      )}
      {state.kind === 'ready' && state.stores.length === 0 && (
        // 空状態の部品は押しボタンを内包しない。次に取れる操作への導線（Req 2.3）は
        // 呼び出し側が children として渡す。要素はリンクのまま、見た目だけを借りる
        // （store-qr-panel.tsx の保存リンクと同じ作法）。
        <EmptyState>
          <p>担当店舗は 0件 です。</p>
          <Link href="/stores/new" className={cn(buttonVariants())}>
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
                {/* 利用中・停止中の表示と、停止・再開の操作（store-suspension Req 2.1–2.3） */}
                <TableHeaderCell>利用状況</TableHeaderCell>
                {/* 店頭設置用 QR の発行導線（store-qr-issuance-ui Req 1.1） */}
                <TableHeaderCell>QR</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {state.stores.map((store) => (
                <Fragment key={store.id}>
                  <TableRow>
                    {/* 折り返しの規則は列の中身の種類で選ぶ（design-language.md 7.18）。
                      * 面の側は語彙を選ぶだけで、幅も折り返しのクラスも書かない。 */}
                    <TableCell wrap="prose">{store.name}</TableCell>
                    {/* 店舗特定バッジ（Req 4.3） */}
                    <TableCell wrap="none">
                      {/* serviceable-predicate: display-only（店舗特定の状態を文字で示すだけで、発行や取得の可否を決めない） */}
                      {store.placeStatus === 'confirmed' ? '確定済み' : '未確定'}
                    </TableCell>
                    {/* 競合設定バッジ（Req 4.3・変更手段は提供しない = 表示のみ Req 4.5） */}
                    <TableCell wrap="none">
                      {store.competitorConfigured ? '競合設定済み' : '競合未設定'}
                    </TableCell>
                    {isOperator && <TableCell wrap="prose">{store.agencyName}</TableCell>}
                    {/* 利用状況は札と押しボタンを 1 行に並べ、その下に結果の文言を出す。札と押しボタンは
                      * 部品側で折り返さないので、この列は自由記述の規則にして結果の文言だけを折り返させる
                      * （折り返さない規則にすると失敗の文言が 1 行に伸び、表の幅を押し広げる）。
                      *
                      * 結果を告げるライブリージョンは行ごとに部品が持つ。1 つに集約しないのは、成功の文言が
                      * 押した行の直下に見える通知を兼ねるためで、1 回の操作で文言が変わる領域は 1 つだけである
                      * （空の領域は何も読み上げない）。 */}
                    <TableCell wrap="prose">
                      <StoreSuspensionControl store={store} onChanged={refreshStores} />
                    </TableCell>
                    {/* 発行の押しボタンと、その代わりに置く理由はどちらも 1 行に収める。
                      * 折り返しを許すと、全店が未確定のときこの列の最小幅が見出し「QR」まで
                      * 落ち、理由の文言が 1 文字ずつ縦に並ぶ。 */}
                    <TableCell wrap="none">
                      {/* 停止中の店舗には発行の操作を出さない（store-suspension Req 5.6）。停止を先に
                        * 判定するのは、場所が未確定でも先に要るのは再開だからである。
                        * それ以外の分岐条件は場所の状態のみ。競合設定の状態を条件に含めない（Req 1.5）。 */}
                      {store.suspendedAt !== null ? (
                        // 確定前の案内とは別の文言にする（design.md「StoresPage の変更」）。色は同じ補足色。
                        <span className="text-muted-foreground">停止中のため発行できません</span>
                      ) : store.placeStatus === 'confirmed' ? (
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
                    // 包み（捲り容器の見えている幅に留める指定）は部品が持つ。折り返しの規則を
                    // 当てて表が容器より広くなったため、この面もその経路を持つようになった。
                    <TableDetailRow colSpan={columnCount} id={panelId(store.id)}>
                      {/* fetchQr は渡さない。インライン関数を渡すと参照が毎描画で変わり、
                        * パネル側の副作用が再走して取得が繰り返される（Req 2.2, 2.3 が同時に壊れる）。 */}
                      <StoreQrPanel
                        key={store.id}
                        storeId={store.id}
                        storeName={store.name}
                        onClose={closePanel}
                      />
                    </TableDetailRow>
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

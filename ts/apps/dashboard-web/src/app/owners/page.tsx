'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { buttonVariants } from '@fwlm/ui/components/button';
import { cn } from '@fwlm/ui/lib/utils';
import { EmptyState } from '@fwlm/ui/components/empty-state';
import { Heading } from '@fwlm/ui/components/heading';
import { PageShell } from '@fwlm/ui/components/page-shell';
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
import { ListLoading } from '../../components/list-loading';
import { ownerDistinctLabel, ownerLineLinkLabel } from '../../components/owner-roster-table';
import { TopNav } from '../../components/top-nav';
import { notifyActionWarning } from '../../lib/action-feedback';
import { useAuth } from '../../lib/auth-context';
import { getOwners } from '../../lib/api';
import type { OwnerListItem } from '../../lib/types';
import { OwnerLineUnlinkControl } from './owner-line-unlink-control';

// オーナー一覧（owner-line-unlink tasks 5.2 / Requirements 2.1–2.4, 2.6, 3.3 / design.md
// 「OwnersPage・OwnerLineUnlinkControl」）。型紙は店舗一覧（stores/page.tsx）で、取得状態・読み直し・
// 版面と表の部品の使い方を揃えている。
//
// 運営は全代理店のオーナーを担当代理店の列つきで、代理店は自代理店のオーナーだけを見る（範囲は
// dashboard-api が利用者の役割から決めるので、どちらも代理店を指定せずに取る）。解除済みのオーナーも
// 一覧から除かない（2.3）。

// 一覧の取得状態。失敗時にデータを偽装しない。
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; owners: OwnerListItem[] };

const OWNER_LIST_ERROR_TEXT =
  'オーナー一覧を読み込めませんでした。通信状況を確認して、画面を再読み込みしてください。';

// 全ロール共通の列数（オーナー名・店舗・LINE の連携・操作）。operator のみ担当代理店列が加わる。
const BASE_COLUMN_COUNT = 4;

function OwnerStoreNames({ storeNames }: { storeNames: readonly string[] }) {
  if (storeNames.length === 0) {
    return <span className="text-muted-foreground">確定済みの店舗はありません</span>;
  }
  return (
    // Preflight が list-style を消すため、一部のブラウザは一覧の意味論を落とす。明示する。
    <ul role="list" className="flex flex-col gap-1">
      {storeNames.map((storeName, index) => (
        // 店名は一意とは限らない（同名の別店舗がありうる）ので、並び順を添えて key にする。
        <li key={`${index}:${storeName}`}>{storeName}</li>
      ))}
    </ul>
  );
}

function OwnersView() {
  const { me } = useAuth();
  const isOperator = me?.role === 'operator';
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const columnCount = BASE_COLUMN_COUNT + (isOperator ? 1 : 0);
  // 解除・外し直しの後の読み直しに失敗したときの文言。表は古い表示のまま残し、失敗だけを別に示す。
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // 読み直しの要求の通し番号。先に出した要求の応答が後から届いて新しい表示を上書きしないよう、
  // 最後の要求の応答だけを採る。
  const refreshSeq = useRef(0);
  // 画面を離れた後に届いた応答で state を書かないための印。
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 解除・外し直しの後の読み直し（Req 2.4）。画面は再読み込みしない。
  //
  // **表を読み込み中の表示へ置き換えない。** 置き換えると行ごと外れ、押した操作部品の焦点と
  // 結果を告げるライブリージョンが失われる。行はオーナー ID を key に持つので、同じオーナーの行と
  // 操作部品は同じ要素のまま残り、中身だけが差し替わる。
  const refreshOwners = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const result = await getOwners({});
    if (!mounted.current || seq !== refreshSeq.current) return;
    if (!result.ok) {
      setRefreshError(OWNER_LIST_ERROR_TEXT);
      notifyActionWarning({
        title: '最新のオーナー一覧を表示できません',
        description: '操作結果を確認するため、画面を再読み込みしてください。',
      });
      return;
    }
    setRefreshError(null);
    setState({ kind: 'ready', owners: result.value });
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await getOwners({});
      if (!active) return;
      if (result.ok) {
        setState({ kind: 'ready', owners: result.value });
      } else {
        setState({ kind: 'error', message: OWNER_LIST_ERROR_TEXT });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <PageShell width="lg" className="flex flex-col gap-6">
      <Heading level={1}>オーナー一覧</Heading>
      {state.kind === 'loading' && (
        // 行の操作として末尾の列に解除・外し直しの押しボタンが 1 つ並ぶ。
        <ListLoading columns={columnCount} actions={1} />
      )}
      {state.kind === 'error' && (
        // 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねない。
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      {refreshError !== null && state.kind === 'ready' && (
        <Alert variant="destructive">
          <AlertDescription>{refreshError}</AlertDescription>
        </Alert>
      )}
      {state.kind === 'ready' && state.owners.length === 0 && (
        // オーナーは LINE で招待コードを入力して初めて現れる。次に取れる操作として招待コードの画面へ導く。
        // 要素はリンクのまま、見た目だけを借りる（stores/page.tsx の登録導線と同じ作法）。
        <EmptyState>
          <p>オーナーはまだいません。</p>
          <Link href="/invite-codes" className={cn(buttonVariants())}>
            招待コードを確認する
          </Link>
        </EmptyState>
      )}
      {state.kind === 'ready' && state.owners.length > 0 && (
        // 横方向の捲りは表の外側の容器が持つ。狭い幅ではこの中で横に捲れ、ページは溢れない。
        <TableContainer label="オーナー一覧">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>オーナー名</TableHeaderCell>
                {/* 運営は全代理店のオーナーを担当代理店で見分ける（Req 2.1） */}
                {isOperator && <TableHeaderCell>担当代理店</TableHeaderCell>}
                <TableHeaderCell>店舗</TableHeaderCell>
                {/* 連携中・解除済み・メニュー未解除・引継ぎ先（Req 2.1, 2.6, 3.3） */}
                <TableHeaderCell>LINE の連携</TableHeaderCell>
                {/* 解除・外し直しの操作（Req 2.2, 2.3, 3.3） */}
                <TableHeaderCell>操作</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {state.owners.map((owner) => (
                <TableRow key={owner.id}>
                  {/* 折り返しの規則は列の中身の種類で選ぶ（design-language.md 7.18）。 */}
                  <TableCell wrap="prose">{ownerDistinctLabel(owner)}</TableCell>
                  {isOperator && <TableCell wrap="prose">{owner.agencyName}</TableCell>}
                  <TableCell wrap="prose">
                    <OwnerStoreNames storeNames={owner.storeNames} />
                  </TableCell>
                  {/* 状態は文字で示し、色だけで伝えない。引継ぎ先の名前は長くなりうるので折り返させる。 */}
                  <TableCell wrap="prose">{ownerLineLinkLabel(owner)}</TableCell>
                  {/* 押しボタンの下に結果の文言を出す。結果の文言だけが折り返すよう、自由記述の規則にする
                    * （折り返さない規則にすると失敗の文言が 1 行に伸び、表の幅を押し広げる）。 */}
                  <TableCell wrap="prose">
                    <OwnerLineUnlinkControl owner={owner} onChanged={refreshOwners} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </PageShell>
  );
}

// 運営・代理店の両方が開く。認可ガードで囲い、共通ナビを添える。
export default function OwnersPage() {
  return (
    <AuthGuard>
      <TopNav />
      <OwnersView />
    </AuthGuard>
  );
}

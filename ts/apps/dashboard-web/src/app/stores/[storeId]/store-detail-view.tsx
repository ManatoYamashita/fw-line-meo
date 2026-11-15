'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { Heading } from '@fwlm/ui/components/heading';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { Spinner } from '@fwlm/ui/components/spinner';
import { textLinkVariants } from '@fwlm/ui/components/text-link';
import { cn } from '@fwlm/ui/lib/utils';
import { AgencyName, EntityLink } from '../../../components/entity-link';
import { ownerDisplayLabel } from '../../../components/owner-roster-table';
import { StoreQrPanel } from '../../../components/store-qr-panel';
import { StoreSuspensionControl } from '../../../components/store-suspension-control';
import { getStore } from '../../../lib/api';
import { useAuth } from '../../../lib/auth-context';
import { toEntityId, ownerPath } from '../../../lib/entity-paths';
import { formatJstDate } from '../../../lib/jst-date';
import { PLACE_STATUS_LABEL, competitorStatusLabel } from '../../../lib/status-labels';
import type { StoreListItem } from '../../../lib/types';

// 店舗の詳細（agency-dashboard Requirement 10.7・11.1–11.5・11.9・11.11–11.14・Issue #526）。
// 店舗 1 件の状態・つながり・操作を 1 画面にまとめる。新しい集計は加えず（11.14）、既存の QR パネルと
// 停止・再開の部品をそのまま置く。変更の手段は停止・再開だけである（11.13）。
//
// 状態は 4 つ（読み込み中・失敗・見つからない・表示）。形の不正な id は API を呼ばずに「見つからない」にする。
// 形の不正・不存在・範囲外は API が同じ 404 で返すので、画面も区別しない（11.9）。失敗を「見つからない」や
// 空の画面に見せない（11.11）。
//
// 確定の比較（placeStatus === 'confirmed'）は、下の QR の分岐の 1 か所だけに書く。概要の「店舗特定」は
// 表示語を添字で引くだけにする（停止の述語ガード check-store-serviceable-predicate.sh の数えに合わせる）。

type Load =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'not_found' }
  | { kind: 'ready'; store: StoreListItem };

const NO_DISPLAY_NAME = '（表示名なし）';
const UNKNOWN_DATE = '不明';
const REFRESH_ERROR_TEXT =
  '最新の店舗の情報を表示できません。操作の結果を確認するため、画面を再読み込みしてください。';

export function StoreDetailView({ storeId: rawStoreId }: { storeId: string }) {
  const { me } = useAuth();
  const isOperator = me?.role === 'operator';
  // 経路の値を小文字の id へ正規化し、取得はこの値で行う（大小で割れない）。
  const storeId = toEntityId(rawStoreId);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  // 停止・再開の後の読み直しの失敗。表は古いまま残し、失敗だけを別に示す。
  const [refreshError, setRefreshError] = useState(false);
  // 読み直しの要求の通し番号。最後の要求の応答だけを採る（店舗一覧の refreshSeq と同じ）。
  // 防御的な備えである。停止・再開の部品は処理中の再押下を受け付けないので、画面の操作からは
  // 古い応答が後から届く状況を作れず、この守りを赤にする試験は置いていない（再読み込みと共有する）。
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback((result: Awaited<ReturnType<typeof getStore>>): Load => {
    if (result.ok) return { kind: 'ready', store: result.value };
    return result.code === 'not_found' ? { kind: 'not_found' } : { kind: 'error' };
  }, []);

  const fetchFirst = useCallback(async () => {
    if (storeId === null) return;
    const issued = ++seq.current;
    let next: Load;
    try {
      next = apply(await getStore(storeId));
    } catch {
      next = { kind: 'error' };
    }
    if (!mounted.current || issued !== seq.current) return;
    setRefreshError(false);
    setLoad(next);
  }, [storeId, apply]);

  useEffect(() => {
    void fetchFirst();
  }, [fetchFirst]);

  const reload = useCallback(() => {
    setLoad({ kind: 'loading' });
    void fetchFirst();
  }, [fetchFirst]);

  // 停止・再開の後の読み直し。表示を読み込み中へ置き換えない（押した操作部品の焦点と結果のライブリージョンを残す）。
  const refresh = useCallback(async () => {
    if (storeId === null) return;
    const issued = ++seq.current;
    let result: Awaited<ReturnType<typeof getStore>>;
    try {
      result = await getStore(storeId);
    } catch {
      result = { ok: false, code: 'unexpected', message: '' };
    }
    if (!mounted.current || issued !== seq.current) return;
    if (!result.ok && result.code !== 'not_found') {
      setRefreshError(true);
      return;
    }
    setRefreshError(false);
    setLoad(apply(result));
  }, [storeId, apply]);

  const backLink = (
    // パンくずを nav で包まない（ナビゲーション領域が帯と合わせて 2 つになる）。
    <Link href="/stores" className={cn(textLinkVariants(), 'self-start text-sm')}>
      店舗一覧へ戻る
    </Link>
  );

  const state: Load = storeId === null ? { kind: 'not_found' } : load;

  if (state.kind !== 'ready') {
    return (
      <PageShell width="lg" className="flex flex-col gap-6">
        {backLink}
        <Heading level={1}>店舗の詳細</Heading>
        {state.kind === 'loading' && (
          <p role="status" className="flex items-center gap-2">
            <Spinner aria-hidden />
            読み込み中...
          </p>
        )}
        {state.kind === 'not_found' && <p>店舗が見つかりません。店舗一覧から選び直してください。</p>}
        {state.kind === 'error' && (
          <div className="flex flex-col items-start gap-3">
            <Alert variant="destructive">
              <AlertDescription>
                店舗の情報を読み込めませんでした。通信状況を確認して、もう一度読み込んでください。
              </AlertDescription>
            </Alert>
            <Button type="button" variant="outline" onClick={reload}>
              もう一度読み込む
            </Button>
          </div>
        )}
      </PageShell>
    );
  }

  const store = state.store;
  return (
    <PageShell width="lg" className="flex flex-col gap-6">
      {backLink}
      <Heading level={1}>{store.name}</Heading>
      {refreshError && (
        <Alert variant="destructive">
          <AlertDescription>{REFRESH_ERROR_TEXT}</AlertDescription>
        </Alert>
      )}

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Item term="店舗特定">{PLACE_STATUS_LABEL[store.placeStatus]}</Item>
        <Item term="競合設定">{competitorStatusLabel(store.competitorConfigured)}</Item>
        <Item term="オーナー">
          <EntityLink href={ownerPath(store.ownerId)}>
            {store.ownerDisplayName === null ? NO_DISPLAY_NAME : ownerDisplayLabel({ displayName: store.ownerDisplayName })}
          </EntityLink>
        </Item>
        {isOperator && (
          <Item term="担当代理店">
            <AgencyName agencyId={store.agencyId} name={store.agencyName} />
          </Item>
        )}
        <Item term="登録日">{formatJstDate(store.createdAt) ?? UNKNOWN_DATE}</Item>
        {/* 利用状況は、状態の札と停止・再開の押しボタンを 1 組で持つ部品に任せる（札を重ねて描かない）。 */}
        <Item term="利用状況">
          <StoreSuspensionControl store={store} onChanged={refresh} />
        </Item>
      </dl>

      <section className="flex flex-col gap-4">
        <Heading level={2}>QR</Heading>
        {/* 停止を先に判定する。場所が未確定でも、先に要るのは再開だからである（店舗一覧と同じ順・store-suspension Req 5.6）。
         * 停止に切り替わったときはパネルごと外し、停止前の画像と保存の導線を残さない。 */}
        {store.suspendedAt !== null ? (
          <p className="text-muted-foreground">停止中のため発行できません</p>
        ) : store.placeStatus === 'confirmed' ? (
          // 店舗の詳細には閉じる先が無いので onClose を渡さず、題は区分の見出しに任せる（10.7）。
          <StoreQrPanel key={store.id} storeId={store.id} storeName={store.name} showHeader={false} />
        ) : (
          <p className="text-muted-foreground">場所の確定が必要です</p>
        )}
      </section>
    </PageShell>
  );
}

function Item({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Badge } from '@fwlm/ui/components/badge';
import { Button } from '@fwlm/ui/components/button';
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
import { textLinkVariants } from '@fwlm/ui/components/text-link';
import { cn } from '@fwlm/ui/lib/utils';
import { AgencyName, EntityLink } from '../../../components/entity-link';
import { OwnerLineUnlinkControl } from '../../../components/owner-line-unlink-control';
import { NO_INVITE_CODE_RECORD, ownerLineLinkLabel } from '../../../components/owner-roster-table';
import { getOwner } from '../../../lib/api';
import { useAuth } from '../../../lib/auth-context';
import { storePath, toEntityId } from '../../../lib/entity-paths';
import { formatJstDate } from '../../../lib/jst-date';
import {
  ENABLED_STATE_LABEL,
  ONBOARDING_STATUS_LABEL,
  PLACE_STATUS_LABEL,
  competitorStatusLabel,
  storeSuspensionLabel,
} from '../../../lib/status-labels';
import type { OwnerDetail } from '../../../lib/types';

// オーナーの詳細（agency-dashboard Requirement 10.7・11.6–11.9・11.11–11.13・Issue #526）。
// オーナー 1 人の状態とつながりと操作を 1 画面にまとめる。変更の手段は LINE の連携の解除だけである（11.13）。
//
// 状態は 4 つ（読み込み中・失敗・見つからない・表示）で、店舗の詳細と同じ。形の不正な id は API を呼ばずに
// 「見つからない」にする。失敗を「見つからない」や空の画面に見せない（11.11）。
//
// 店舗の表は表示だけにする（11.7）。停止・再開と QR の操作は、店名から店舗の詳細へ進んで行う。
// 店舗の状態は表示語を添字・関数で引くだけで、確定の比較をこのファイルに書かない
// （停止の述語ガード check-store-serviceable-predicate.sh の数えに加えない）。

type Load =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'not_found' }
  | { kind: 'ready'; detail: OwnerDetail };

const NO_DISPLAY_NAME = '（表示名なし）';
const UNKNOWN_DATE = '不明';
const REFRESH_ERROR_TEXT =
  '最新のオーナーの情報を表示できません。操作の結果を確認するため、画面を再読み込みしてください。';

export function OwnerDetailView({ ownerId: rawOwnerId }: { ownerId: string }) {
  const { me } = useAuth();
  const isOperator = me?.role === 'operator';
  // 経路の値を小文字の id へ正規化し、取得はこの値で行う（大小で割れない）。
  const ownerId = toEntityId(rawOwnerId);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  // 連携の解除の後の読み直しの失敗。表示は古いまま残し、失敗だけを別に示す。
  const [refreshError, setRefreshError] = useState(false);
  // 要求の通し番号。最後の要求の応答だけを採る（店舗の詳細と同じ。防御的な備えで、解除の部品が
  // 処理中の再押下を受け付けないため、画面の操作からは古い応答が後から届く状況を作れない）。
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback((result: Awaited<ReturnType<typeof getOwner>>): Load => {
    if (result.ok) return { kind: 'ready', detail: result.value };
    return result.code === 'not_found' ? { kind: 'not_found' } : { kind: 'error' };
  }, []);

  const fetchFirst = useCallback(async () => {
    if (ownerId === null) return;
    const issued = ++seq.current;
    let next: Load;
    try {
      next = apply(await getOwner(ownerId));
    } catch {
      next = { kind: 'error' };
    }
    if (!mounted.current || issued !== seq.current) return;
    setRefreshError(false);
    setLoad(next);
  }, [ownerId, apply]);

  useEffect(() => {
    void fetchFirst();
  }, [fetchFirst]);

  const reload = useCallback(() => {
    setLoad({ kind: 'loading' });
    void fetchFirst();
  }, [fetchFirst]);

  // 連携の解除の後の読み直し。表示を読み込み中へ置き換えない（押した操作部品の焦点と結果の
  // ライブリージョンを残す）。
  const refresh = useCallback(async () => {
    if (ownerId === null) return;
    const issued = ++seq.current;
    let result: Awaited<ReturnType<typeof getOwner>>;
    try {
      result = await getOwner(ownerId);
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
  }, [ownerId, apply]);

  const backLink = (
    // パンくずを nav で包まない（ナビゲーション領域が帯と合わせて 2 つになる）。
    <Link href="/owners" className={cn(textLinkVariants(), 'self-start text-sm')}>
      オーナー一覧へ戻る
    </Link>
  );

  const state: Load = ownerId === null ? { kind: 'not_found' } : load;

  if (state.kind !== 'ready') {
    return (
      <PageShell width="lg" className="flex flex-col gap-6">
        {backLink}
        <Heading level={1}>オーナーの詳細</Heading>
        {state.kind === 'loading' && (
          <p role="status" className="flex items-center gap-2">
            <Spinner aria-hidden />
            読み込み中...
          </p>
        )}
        {state.kind === 'not_found' && <p>オーナーが見つかりません。オーナー一覧から選び直してください。</p>}
        {state.kind === 'error' && (
          <div className="flex flex-col items-start gap-3">
            <Alert variant="destructive">
              <AlertDescription>
                オーナーの情報を読み込めませんでした。通信状況を確認して、もう一度読み込んでください。
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

  const { owner, stores } = state.detail;
  return (
    <PageShell width="lg" className="flex flex-col gap-6">
      {backLink}
      <Heading level={1}>{owner.displayName ?? NO_DISPLAY_NAME}</Heading>
      {refreshError && (
        <Alert variant="destructive">
          <AlertDescription>{REFRESH_ERROR_TEXT}</AlertDescription>
        </Alert>
      )}

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Item term="状態">{ONBOARDING_STATUS_LABEL[owner.onboardingStatus]}</Item>
        <Item term="登録日">{formatJstDate(owner.createdAt) ?? UNKNOWN_DATE}</Item>
        <Item term="招待コード">
          {owner.inviteCode === null ? (
            <span className="text-muted-foreground">{NO_INVITE_CODE_RECORD}</span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <span>{owner.inviteCode.code}</span>
              {owner.inviteCode.disabled && <Badge variant="outline">{ENABLED_STATE_LABEL.disabled}</Badge>}
            </span>
          )}
        </Item>
        {isOperator && (
          <Item term="担当代理店">
            <AgencyName agencyId={owner.agencyId} name={owner.agencyName} />
          </Item>
        )}
        {/* 引継ぎ先は文中の名前なので、リンクにしない（10.7）。 */}
        <Item term="LINE の連携">{ownerLineLinkLabel(owner)}</Item>
      </dl>

      {/* 連携の解除・メニューの外し直し。解除済みでメニューも外し終えていれば、部品が何も出さない。 */}
      <OwnerLineUnlinkControl owner={owner} onChanged={refresh} />

      <section className="flex flex-col gap-4">
        <Heading level={2}>店舗</Heading>
        {stores.length === 0 ? (
          <EmptyState>
            <p>このオーナーの店舗はありません。</p>
          </EmptyState>
        ) : (
          <TableContainer label="店舗">
            <Table density="responsive">
              <TableHead>
                <TableRow>
                  <TableHeaderCell>店名</TableHeaderCell>
                  <TableHeaderCell>店舗特定</TableHeaderCell>
                  <TableHeaderCell>競合設定</TableHeaderCell>
                  <TableHeaderCell>利用状況</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {stores.map((store) => (
                  <TableRow key={store.id}>
                    <TableCell wrap="prose">
                      <EntityLink href={storePath(store.id)}>{store.name}</EntityLink>
                    </TableCell>
                    <TableCell wrap="none">{PLACE_STATUS_LABEL[store.placeStatus]}</TableCell>
                    <TableCell wrap="none">{competitorStatusLabel(store.competitorConfigured)}</TableCell>
                    <TableCell wrap="none">{storeSuspensionLabel(store.suspendedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>
    </PageShell>
  );
}

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
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
import { ListLoading } from '../../../../components/list-loading';
import { OwnerRosterTable, ownerDistinctLabel } from '../../../../components/owner-roster-table';
import { groupStoresByOwner } from '../../../../lib/agency-roster';
import {
  ownersByInviteCode,
  toAgencyId,
  unrecordedOwnerCount,
  usersOfAgency,
} from '../../../../lib/agency-detail';
import {
  getAgencies,
  getDashboardUsers,
  getInviteCodes,
  getOwners,
  getStores,
  type ApiResult,
} from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth-context';
import { formatJstDate } from '../../../../lib/jst-date';
import {
  PLACE_STATUS_LABEL,
  enabledStateLabel,
  storeSuspensionLabel,
} from '../../../../lib/status-labels';
import type {
  AgencyItem,
  DashboardUserItem,
  InviteCodeItem,
  OwnerListItem,
  StoreListItem,
} from '../../../../lib/types';

// 代理店ごとの詳細（Issue #486・agency-dashboard Requirement 9）。運営専用・閲覧のみ（9.10）。
//
// 一覧の状態列（有効／無効・店舗特定・利用状況）は、招待コード・利用者管理・店舗一覧と同じく素の語で置く。
//
// 5 本の取得を同時に発行し、区分ごとに状態を持つ（9.7）。1 区分の失敗で画面全体を消さず、
// 失敗した区分とその件数を 0 件とは見せない（Req 7.4 を区分の単位で適用する）。
//
// **代理店の存在は GET /agencies の結果だけで判定する**（9.6）。存在しない代理店を指定しても、
// GET /owners などはスコープの解決だけで空配列を返しうる。判定がつくまで区分も件数も描かない。
// そうしないと、存在しない代理店が「0 人・0 件の代理店」に見える。

/** 区分の取得状態。 */
type Load<T> = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; value: T };

/** 代理店の存在判定の状態。 */
type AgencyLoad =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'not_found' }
  | { kind: 'ready'; agency: AgencyItem };

const UNKNOWN_DATE = '不明';
const NO_DISPLAY_NAME = '（表示名なし）';
const LOAD_FAILED = '読み込めませんでした';
const NO_EMAIL = '（メールアドレスなし）';

/**
 * 1 区分の取得。呼ぶたびに番号を進め、最後に発行した取得の応答だけを状態へ書く（再読み込みの
 * 連打や画面を離れた後に届いた古い応答で、新しい状態を上書きしない）。
 *
 * 最初の取得は effect から発行し、状態は初期値の `loading` のまま待つ（effect の中で同期的に
 * 状態を書かない）。再読み込みは押下の処理から `loading` に戻してから発行する。
 */
function useSection<T, R = T>(
  enabled: boolean,
  fetcher: () => Promise<ApiResult<R>>,
  select: (value: R) => T,
): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' });
  const latest = useRef(0);

  const start = useCallback(() => {
    latest.current += 1;
    const issued = latest.current;
    void fetcher().then(
      (result) => {
        if (latest.current !== issued) return;
        setState(result.ok ? { kind: 'ready', value: select(result.value) } : { kind: 'error' });
      },
      () => {
        if (latest.current !== issued) return;
        setState({ kind: 'error' });
      },
    );
  }, [fetcher, select]);

  useEffect(() => {
    if (!enabled) return;
    start();
    return () => {
      // 画面を離れた後に届く応答を捨てる。
      latest.current += 1;
    };
  }, [enabled, start]);

  const reload = useCallback(() => {
    setState({ kind: 'loading' });
    start();
  }, [start]);

  return [state, reload];
}

function identity<T>(value: T): T {
  return value;
}

/** 区分の取得失敗。その区分だけを取り直す押しボタンを添える（9.7）。 */
function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねない。 */}
      <Alert variant="destructive">
        <AlertDescription>{message}</AlertDescription>
      </Alert>
      <Button type="button" variant="outline" onClick={onRetry}>
        もう一度読み込む
      </Button>
    </div>
  );
}

/** 概要の件数。取得中・失敗を 0 と出さない（9.3・9.7）。 */
function countText<T>(load: Load<T>, count: (value: T) => number): string {
  if (load.kind === 'loading') return '読み込み中';
  if (load.kind === 'error') return LOAD_FAILED;
  return `${count(load.value)}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  // 名前を付けない section（名前を持つと領域になり、表の捲れる領域と合わせて領域が増える）。
  return (
    <section className="flex flex-col gap-4">
      <Heading level={2}>{title}</Heading>
      {children}
    </section>
  );
}

export function AgencyDetailView({ agencyId: rawAgencyId }: { agencyId: string }) {
  const { me } = useAuth();
  const isOperator = me?.role === 'operator';
  // 経路の値を小文字の id へ正規化し、取得・存在判定・絞り込みのすべてでこの値を使う（大小で割れない）。
  const normalizedId = toAgencyId(rawAgencyId);
  const validId = normalizedId !== null;
  const agencyId = normalizedId ?? '';
  // 代理店ロールと形の不正な id では 1 本も取得しない（9.6・9.9）。
  const enabled = isOperator && validId;

  const fetchAgencies = useCallback(() => getAgencies(), []);
  const selectAgency = useCallback(
    (agencies: AgencyItem[]): AgencyItem | null => agencies.find((a) => a.id === agencyId) ?? null,
    [agencyId],
  );
  const fetchUsers = useCallback(() => getDashboardUsers(), []);
  const selectUsers = useCallback(
    (users: DashboardUserItem[]) => usersOfAgency(users, agencyId),
    [agencyId],
  );
  const fetchOwners = useCallback(() => getOwners({ agencyId }), [agencyId]);
  const fetchStores = useCallback(() => getStores({ agencyId }), [agencyId]);
  const fetchCodes = useCallback(() => getInviteCodes({ agencyId }), [agencyId]);

  const [agencyLoad, reloadAgency] = useSection(enabled, fetchAgencies, selectAgency);
  const [users, reloadUsers] = useSection(enabled, fetchUsers, selectUsers);
  const [owners, reloadOwners] = useSection<OwnerListItem[]>(enabled, fetchOwners, identity);
  const [stores, reloadStores] = useSection<StoreListItem[]>(enabled, fetchStores, identity);
  const [codes, reloadCodes] = useSection<InviteCodeItem[]>(enabled, fetchCodes, identity);

  // 非 operator には管理情報を一切描画しない（9.9。実際の認可は API 側・Req 6.5）。
  if (!isOperator) {
    return (
      <PageShell width="lg" className="flex flex-col gap-6">
        <Heading level={1}>代理店詳細</Heading>
        <Alert variant="destructive">
          <AlertDescription>この画面は運営のみ利用できます。</AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  const agency: AgencyLoad = !validId
    ? { kind: 'not_found' }
    : agencyLoad.kind === 'ready'
      ? agencyLoad.value === null
        ? { kind: 'not_found' }
        : { kind: 'ready', agency: agencyLoad.value }
      : agencyLoad;

  const backLink = (
    // パンくずを nav で包まない（ナビゲーション領域が帯と合わせて 2 つになる）。
    <Link href="/admin/agencies" className="self-start text-sm">
      代理店管理へ戻る
    </Link>
  );

  if (agency.kind !== 'ready') {
    return (
      <PageShell width="lg" className="flex flex-col gap-6">
        {backLink}
        <Heading level={1}>代理店詳細</Heading>
        {agency.kind === 'loading' && (
          <p role="status" className="flex items-center gap-2">
            <Spinner aria-hidden />
            読み込み中...
          </p>
        )}
        {agency.kind === 'not_found' && <p>代理店が見つかりません。代理店管理の一覧から選び直してください。</p>}
        {agency.kind === 'error' && (
          <SectionError
            message="代理店の情報を読み込めませんでした。通信状況を確認して、もう一度読み込んでください。"
            onRetry={reloadAgency}
          />
        )}
      </PageShell>
    );
  }

  const ownersByCode = owners.kind === 'ready' ? ownersByInviteCode(owners.value) : null;
  const storesForRoster =
    stores.kind === 'ready'
      ? ({ kind: 'loaded', byOwner: groupStoresByOwner(stores.value) } as const)
      : ({ kind: 'error' } as const);

  return (
    <PageShell width="lg" className="flex flex-col gap-6">
      {backLink}
      <div className="flex flex-col gap-1">
        <Heading level={1}>{agency.agency.name}</Heading>
        <p className="text-sm text-muted-foreground">
          作成日 {formatJstDate(agency.agency.createdAt) ?? UNKNOWN_DATE}
        </p>
      </div>

      {/* 概要の件数（9.3）。名前と値の組なので定義リストで描く。 */}
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { term: 'ダッシュボードの利用者', value: countText(users, (v: DashboardUserItem[]) => v.length) },
          { term: 'オーナー', value: countText(owners, (v: OwnerListItem[]) => v.length) },
          { term: '店舗', value: countText(stores, (v: StoreListItem[]) => v.length) },
          {
            term: '有効な招待コード',
            value: countText(codes, (v: InviteCodeItem[]) => v.filter((c) => !c.disabled).length),
          },
        ].map((item) => (
          <div key={item.term} className="flex flex-col gap-1">
            <dt className="text-sm text-muted-foreground">{item.term}</dt>
            <dd className="text-lg font-semibold">{item.value}</dd>
          </div>
        ))}
      </dl>

      <Section title="ダッシュボードの利用者">
        {users.kind === 'loading' && <ListLoading columns={3} />}
        {users.kind === 'error' && (
          <SectionError message="ダッシュボードの利用者を読み込めませんでした。" onRetry={reloadUsers} />
        )}
        {users.kind === 'ready' && users.value.length === 0 && (
          <EmptyState>
            <p>この代理店のダッシュボード利用者はいません。</p>
            <Link href="/admin/users">利用者管理へ</Link>
          </EmptyState>
        )}
        {users.kind === 'ready' && users.value.length > 0 && (
          <TableContainer label="ダッシュボードの利用者">
            <Table density="responsive">
              <TableHead>
                <TableRow>
                  <TableHeaderCell>メールアドレス</TableHeaderCell>
                  <TableHeaderCell>表示名</TableHeaderCell>
                  <TableHeaderCell>状態</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {users.value.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell wrap="anywhere">{user.email ?? NO_EMAIL}</TableCell>
                    <TableCell wrap="prose">{user.displayName ?? NO_DISPLAY_NAME}</TableCell>
                    <TableCell wrap="none">{enabledStateLabel(user.disabled)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Section>

      <Section title="オーナー">
        <p className="text-sm text-muted-foreground">
          LINE の友だち登録を解除（ブロック）したオーナーも、区別せずに表示しています。
        </p>
        {(owners.kind === 'loading' || (owners.kind === 'ready' && stores.kind === 'loading')) && (
          <ListLoading columns={5} />
        )}
        {owners.kind === 'error' && (
          <SectionError message="オーナーを読み込めませんでした。" onRetry={reloadOwners} />
        )}
        {owners.kind === 'ready' && stores.kind !== 'loading' && owners.value.length === 0 && (
          <EmptyState>
            <p>この代理店のオーナーはいません。オーナーが LINE で招待コードを入力すると、ここに表示されます。</p>
          </EmptyState>
        )}
        {owners.kind === 'ready' && stores.kind !== 'loading' && owners.value.length > 0 && (
          <OwnerRosterTable label="オーナー" owners={owners.value} stores={storesForRoster} showInviteCode />
        )}
      </Section>

      <Section title="店舗">
        {stores.kind === 'loading' && <ListLoading columns={4} />}
        {stores.kind === 'error' && (
          <SectionError message="店舗を読み込めませんでした。" onRetry={reloadStores} />
        )}
        {stores.kind === 'ready' && stores.value.length === 0 && (
          <EmptyState>
            <p>この代理店の店舗はまだ登録されていません。</p>
          </EmptyState>
        )}
        {stores.kind === 'ready' && stores.value.length > 0 && (
          <TableContainer label="店舗">
            <Table density="responsive">
              <TableHead>
                <TableRow>
                  <TableHeaderCell>店名</TableHeaderCell>
                  <TableHeaderCell>オーナー</TableHeaderCell>
                  <TableHeaderCell>店舗特定</TableHeaderCell>
                  <TableHeaderCell>利用状況</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {stores.value.map((store) => (
                  <TableRow key={store.id}>
                    <TableCell wrap="prose">{store.name}</TableCell>
                    <TableCell wrap="prose">{store.ownerDisplayName ?? NO_DISPLAY_NAME}</TableCell>
                    <TableCell wrap="none">{PLACE_STATUS_LABEL[store.placeStatus]}</TableCell>
                    <TableCell wrap="none">{storeSuspensionLabel(store.suspendedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Section>

      <Section title="招待コード">
        {codes.kind === 'loading' && <ListLoading columns={4} />}
        {codes.kind === 'error' && (
          <SectionError message="招待コードを読み込めませんでした。" onRetry={reloadCodes} />
        )}
        {codes.kind === 'ready' && codes.value.length === 0 && (
          <EmptyState>
            <p>この代理店の招待コードはまだ発行されていません。</p>
          </EmptyState>
        )}
        {codes.kind === 'ready' && codes.value.length > 0 && (
          <>
            <TableContainer label="招待コード">
              <Table density="responsive">
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>コード</TableHeaderCell>
                    <TableHeaderCell>状態</TableHeaderCell>
                    <TableHeaderCell>発行日</TableHeaderCell>
                    <TableHeaderCell>このコードで登録したオーナー</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {codes.value.map((code) => (
                    <TableRow key={code.id}>
                      <TableCell wrap="none">{code.code}</TableCell>
                      <TableCell wrap="none">{enabledStateLabel(code.disabled)}</TableCell>
                      <TableCell wrap="none">{formatJstDate(code.createdAt) ?? UNKNOWN_DATE}</TableCell>
                      <TableCell wrap="prose">
                        <RegisteredOwners owners={owners} byCode={ownersByCode} codeId={code.id} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            {owners.kind === 'ready' && unrecordedOwnerCount(owners.value) > 0 && (
              <p className="text-sm text-muted-foreground">
                招待コードの記録がないオーナーが {unrecordedOwnerCount(owners.value)} 人います（この機能より前の登録）。
              </p>
            )}
          </>
        )}
        <Link href="/invite-codes" className="self-start text-sm">
          招待コードの発行・無効化は招待コードの画面で行います
        </Link>
      </Section>
    </PageShell>
  );
}

/** 招待コードで登録したオーナーの名前（9.2）。オーナーの取得に失敗したときは 0 人と出さない（9.7）。 */
function RegisteredOwners({
  owners,
  byCode,
  codeId,
}: {
  owners: Load<OwnerListItem[]>;
  byCode: ReadonlyMap<string, readonly OwnerListItem[]> | null;
  codeId: string;
}) {
  if (owners.kind === 'loading') return <span className="text-muted-foreground">読み込み中</span>;
  if (owners.kind === 'error' || byCode === null) {
    return <span className="text-muted-foreground">{LOAD_FAILED}</span>;
  }
  const registered = byCode.get(codeId) ?? [];
  if (registered.length === 0) return <span className="text-muted-foreground">まだいません</span>;
  return (
    <ul role="list" className="flex flex-col gap-1">
      {registered.map((owner) => (
        // 表示名の無いオーナー同士も作成日で区別できる名前にする。
        <li key={owner.id}>{ownerDistinctLabel(owner)}</li>
      ))}
    </ul>
  );
}

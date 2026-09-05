'use client';

import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { EmptyState } from '@fwlm/ui/components/empty-state';
import { Heading } from '@fwlm/ui/components/heading';
import { Input } from '@fwlm/ui/components/input';
import { Label } from '@fwlm/ui/components/label';
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
import { AuthGuard } from '../../../components/auth-guard';
import { TopNav } from '../../../components/top-nav';
import { useAuth } from '../../../lib/auth-context';
import { createAgency, getAgencies } from '../../../lib/api';
import type { AgencyItem } from '../../../lib/types';

// 代理店一覧の取得状態（7.4: 失敗時にデータを偽装しない）。
type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; agencies: AgencyItem[] };

function AgenciesView() {
  const { me } = useAuth();
  // operator 専用画面。agency ロールは案内のみ（クライアント側 UX ゲート。実際の認可は API 側・Req 6.5）。
  const isOperator = me?.role === 'operator';

  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [name, setName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // operator のみ一覧を取得する（agency では依存 API を一切呼ばない）。
  useEffect(() => {
    if (!isOperator) return;
    let active = true;
    void (async () => {
      const result = await getAgencies();
      if (!active) return;
      if (result.ok) setList({ kind: 'ready', agencies: result.value });
      else setList({ kind: 'error', message: result.message });
    })();
    return () => {
      active = false;
    };
  }, [isOperator]);

  // 非 operator には管理情報・作成手段を一切描画しない（Req 6.5）。
  if (!isOperator) {
    return (
      // 分岐ごとに版面を変えない（同じ面が分岐で別の幅に見えると、どちらが本来か読めなくなる）。
      // 主要領域はここでも 1 つである（下の return と排他）。
      <PageShell width="lg" className="flex flex-col gap-6">
        <Heading level={1}>代理店管理</Heading>
        {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねない。 */}
        <Alert variant="destructive">
          <AlertDescription>この画面は運営のみ利用できます。</AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  // 一覧を取り直す（作成後の反映に使う・Req 6.1）。
  async function reload() {
    setList({ kind: 'loading' });
    const result = await getAgencies();
    if (result.ok) setList({ kind: 'ready', agencies: result.value });
    else setList({ kind: 'error', message: result.message });
  }

  // 代理店作成（Req 6.1）。空名はクライアント側で弾き、サーバー 400 も日本語に写す。
  async function handleCreate() {
    setFormError(null);
    const trimmed = name.trim();
    if (trimmed === '') {
      setFormError('代理店名を入力してください。');
      return;
    }
    setSubmitting(true);
    const result = await createAgency({ name: trimmed });
    setSubmitting(false);
    if (result.ok) {
      setName('');
      await reload();
    } else if (result.code === 'validation_failed') {
      setFormError('代理店名を入力してください。');
    } else {
      setFormError('代理店の作成に失敗しました。時間をおいて再試行してください。');
    }
  }

  return (
    // 一覧が主の面なので版面は広い側を使う。既存の main を **置換** する（入れ子にしない）。
    <PageShell width="lg" className="flex flex-col gap-6">
      <Heading level={1}>代理店管理</Heading>

      {/* 幅の制約は広い版面でだけ効かせる（携帯端末幅の実測を動かさないため）。 */}
      <div className="flex flex-col gap-2 sm:max-w-xs">
        <Label htmlFor="agency-name">代理店名</Label>
        <Input
          id="agency-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {/* 無効の通知手段は変えない（素の無効属性のまま。焦点の到達を要求する箇所とは別枠）。 */}
        <Button
          type="button"
          className="self-start"
          onClick={() => void handleCreate()}
          disabled={submitting}
        >
          代理店作成
        </Button>
      </div>

      {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねると
        * 領域が二重になるため、文言は説明の受け口へ置くだけにする。 */}
      {formError !== null && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      {list.kind === 'loading' && (
        // Spinner 自身も role="status" を持つため、読み上げはこの行に一本化する。
        // 図形は装飾として扱い aria-hidden で支援技術から外す。文言は可視のテキストのまま残す
        // （Spinner の aria-label へ移すと sr-only の子要素へ落ちる・Req 4.5）。
        <p role="status" className="flex items-center gap-2">
          <Spinner aria-hidden />
          読み込み中...
        </p>
      )}
      {list.kind === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>{list.message}</AlertDescription>
        </Alert>
      )}

      {list.kind === 'ready' && list.agencies.length === 0 && (
        <EmptyState>
          <p>代理店はまだありません。作成してください。</p>
        </EmptyState>
      )}

      {list.kind === 'ready' && list.agencies.length > 0 && (
        // 横方向の捲りは表の **外側** が持つ。この容器は e2e（dashboard-surfaces.spec.ts）が
        // 宣言する「表の捲れる領域 1 件」である。
        <TableContainer label="代理店一覧">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>代理店名</TableHeaderCell>
                <TableHeaderCell>作成日時</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {list.agencies.map((agency) => (
                <TableRow key={agency.id}>
                  <TableCell>{agency.name}</TableCell>
                  <TableCell>{agency.createdAt}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </PageShell>
  );
}

// 代理店管理（運営専用）。認可ガードで囲い、共通ナビを添える。全文言日本語（Req 7.3）。
export default function AdminAgenciesPage() {
  return (
    <AuthGuard>
      <TopNav />
      <AgenciesView />
    </AuthGuard>
  );
}

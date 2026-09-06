'use client';

import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { EmptyState } from '@fwlm/ui/components/empty-state';
import { Field, FieldGroup } from '@fwlm/ui/components/field';
import { Heading } from '@fwlm/ui/components/heading';
import { Label } from '@fwlm/ui/components/label';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { Select } from '@fwlm/ui/components/select';
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
import { TopNav } from '../../components/top-nav';
import { useAuth } from '../../lib/auth-context';
import { disableInviteCode, getAgencies, getInviteCodes, issueInviteCode } from '../../lib/api';
import type { AgencyItem, InviteCodeItem } from '../../lib/types';

// 招待コード一覧の取得状態（7.4: 失敗時にデータを偽装しない）。
//   idle    … operator が代理店未選択（一覧を出さず選択を促す）
//   loading … 取得中
//   error   … 取得失敗（案内のみ）
//   ready   … 取得済み
type ListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; codes: InviteCodeItem[] };

function InviteCodesView() {
  const { me } = useAuth();
  const isOperator = me?.role === 'operator';

  // operator のみ代理店セレクタを持つ。agency は自代理店固定。
  const [agencies, setAgencies] = useState<AgencyItem[] | null>(null);
  const [selectedAgencyId, setSelectedAgencyId] = useState('');
  const [list, setList] = useState<ListState>(isOperator ? { kind: 'idle' } : { kind: 'loading' });

  // 発行された新規コード。オーナーに案内するため強調表示する（Req 5.2）。
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  // 発行・無効化の操作エラー（一覧の取得エラーとは別枠で提示。Req 7.4）。
  const [actionError, setActionError] = useState<string | null>(null);

  // 現在のスコープ agencyId。operator は選択値（未選択は undefined）、agency は常に undefined（=自代理店）。
  const scopeAgencyId = isOperator && selectedAgencyId !== '' ? selectedAgencyId : undefined;
  // 発行・無効化の操作を提示してよいか（agency は常に可、operator は代理店選択後のみ）。
  const canOperate = !isOperator || selectedAgencyId !== '';

  // operator: 代理店一覧を読み込む（agency は不要）。
  useEffect(() => {
    if (!isOperator) return;
    let active = true;
    void (async () => {
      const result = await getAgencies();
      if (!active) return;
      if (result.ok) setAgencies(result.value);
      else setList({ kind: 'error', message: result.message });
    })();
    return () => {
      active = false;
    };
  }, [isOperator]);

  // agency: 初期ロードで自代理店の招待コードを取得する。
  useEffect(() => {
    if (isOperator) return;
    let active = true;
    void (async () => {
      const result = await getInviteCodes({});
      if (!active) return;
      if (result.ok) setList({ kind: 'ready', codes: result.value });
      else setList({ kind: 'error', message: result.message });
    })();
    return () => {
      active = false;
    };
  }, [isOperator]);

  // スコープの招待コードを取り直す（発行・無効化後の再取得にも使う）。
  async function reload(agencyId: string | undefined) {
    setList({ kind: 'loading' });
    const result = await getInviteCodes(agencyId === undefined ? {} : { agencyId });
    if (result.ok) setList({ kind: 'ready', codes: result.value });
    else setList({ kind: 'error', message: result.message });
  }

  // operator: 代理店を選び直したら、その代理店のコード一覧を取得する（Req 5.4）。
  function handleSelectAgency(agencyId: string) {
    setSelectedAgencyId(agencyId);
    setIssuedCode(null);
    setActionError(null);
    if (agencyId === '') {
      setList({ kind: 'idle' });
      return;
    }
    void reload(agencyId);
  }

  // 発行（Req 5.2）。成功時は新コードを案内表示し一覧を取り直す。
  async function handleIssue() {
    setActionError(null);
    setIssuedCode(null);
    const result = await issueInviteCode(scopeAgencyId === undefined ? {} : { agencyId: scopeAgencyId });
    if (result.ok) {
      setIssuedCode(result.value.code);
      await reload(scopeAgencyId);
    } else {
      setActionError('発行に失敗しました。時間をおいて再試行してください。');
    }
  }

  // 無効化（Req 5.3）。成功時は一覧を取り直して当該行を無効表示にする。
  async function handleDisable(id: string) {
    setActionError(null);
    const result = await disableInviteCode(scopeAgencyId === undefined ? { id } : { id, agencyId: scopeAgencyId });
    if (result.ok) {
      await reload(scopeAgencyId);
    } else {
      setActionError('無効化に失敗しました。時間をおいて再試行してください。');
    }
  }

  return (
    // 一覧が主の面なので版面は広い側を使う。既存の main を **置換** する（入れ子にしない）。
    <PageShell width="lg" className="flex flex-col gap-6">
      <Heading level={1}>招待コード</Heading>

      {isOperator && (
        <FieldGroup>
          <Field className="contents">
            {/* **段落ではなく汎用の容器で包む。** 選択の部品は開閉の記号を重ねるために div を
              1 枚挟むので、段落の直下には置けない。置くとブラウザの構文解析が段落を早期に閉じ、
              サーバ描画とクライアント描画の木が食い違う。
              幅の制約は広い版面でだけ効かせる（携帯端末幅の実測を動かさないため）。 */}
            <div className="flex flex-col gap-2 sm:max-w-xs">
              <Label htmlFor="agency-select">代理店</Label>
              {/* 標準の選択要素のラッパである。id・value・onChange はいずれも選択要素へ透過し、
                * ラベルとの関連付けもプログラムによる値の変更もそのまま働く（Req 5.4）。 */}
              <Select
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
              </Select>
            </div>
          </Field>
        </FieldGroup>
      )}

      {/* operator が代理店未選択のときは一覧を出さず、選択を促す（Req 5.4） */}
      {list.kind === 'idle' && (
        <EmptyState>
          <p>代理店を選択すると招待コードを表示します。</p>
        </EmptyState>
      )}

      {canOperate && (
        <>
          {/* 版面は縦の flex なので、そのまま置くと押しボタンが行幅いっぱいに伸びる。
            * 主操作を全幅にするのはログイン画面の判断（正典 7.9）であってこの面の判断ではない。 */}
          <Button type="button" className="self-start" onClick={() => void handleIssue()}>
            発行
          </Button>

          {/* 発行した新コードをオーナー案内用に強調表示する（Req 5.2）。
            * 失敗ではないので読み上げは polite（成功の変種が role="status" を自ら持つ）。 */}
          {issuedCode !== null && (
            <Alert variant="success">
              <AlertDescription>
                新しい招待コードを発行しました: <strong>{issuedCode}</strong>（このコードをオーナーにご案内ください）
              </AlertDescription>
            </Alert>
          )}

          {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねると
            * 領域が二重になるため、文言は説明の受け口へ置くだけにする。 */}
          {actionError !== null && (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
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

          {list.kind === 'ready' && list.codes.length === 0 && (
            <EmptyState>
              <p>招待コードはまだありません。発行してオーナーにご案内ください。</p>
            </EmptyState>
          )}

          {list.kind === 'ready' && list.codes.length > 0 && (
            // 横方向の捲りは表の **外側** が持つ。この容器は e2e（dashboard-surfaces.spec.ts）が
            // 宣言する「表の捲れる領域 1 件」である。
            <TableContainer label="招待コード">
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>コード</TableHeaderCell>
                    <TableHeaderCell>状態</TableHeaderCell>
                    <TableHeaderCell>作成日時</TableHeaderCell>
                    <TableHeaderCell>操作</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {list.codes.map((code) => (
                    <TableRow key={code.id}>
                      <TableCell>{code.code}</TableCell>
                      {/* 有効/無効バッジ（Req 5.1） */}
                      <TableCell>{code.disabled ? '無効' : '有効'}</TableCell>
                      <TableCell>{code.createdAt}</TableCell>
                      <TableCell>
                        {/* 無効化は有効な行にのみ提供する（Req 5.3。API は冪等） */}
                        {!code.disabled && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void handleDisable(code.id)}
                          >
                            無効化
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      )}
    </PageShell>
  );
}

// 招待コード管理。認可ガードで囲い、共通ナビを添える。全文言日本語（Req 7.3）。
export default function InviteCodesPage() {
  return (
    <AuthGuard>
      <TopNav />
      <InviteCodesView />
    </AuthGuard>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { EmptyState } from '@fwlm/ui/components/empty-state';
import { Field, FieldGroup } from '@fwlm/ui/components/field';
import { Heading } from '@fwlm/ui/components/heading';
import { Input } from '@fwlm/ui/components/input';
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
import { AuthGuard } from '../../../components/auth-guard';
import { TopNav } from '../../../components/top-nav';
import { useAuth } from '../../../lib/auth-context';
import {
  createDashboardUser,
  disableDashboardUser,
  enableDashboardUser,
  getAgencies,
  getDashboardUsers,
  type DashboardRole,
} from '../../../lib/api';
import type { AgencyItem, DashboardUserItem } from '../../../lib/types';

// 利用者一覧の取得状態（7.4: 失敗時にデータを偽装しない）。
type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; users: DashboardUserItem[] };

// ロール表示名（日本語・Req 7.3）。
function roleLabel(role: DashboardRole): string {
  return role === 'operator' ? '運営' : '代理店';
}

function UsersView() {
  const { me } = useAuth();
  // operator 専用画面。agency ロールは案内のみ（クライアント側 UX ゲート。実際の認可は API 側・Req 6.5）。
  const isOperator = me?.role === 'operator';

  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [agencies, setAgencies] = useState<AgencyItem[]>([]);

  // 登録フォーム状態。既定は代理店ロール（所属代理店の指定が必要な側）。
  const [role, setRole] = useState<DashboardRole>('agency');
  const [agencyId, setAgencyId] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 無効化操作のエラー（登録フォームのエラーとは別枠・Req 7.4）。
  const [actionError, setActionError] = useState<string | null>(null);

  // operator のみ利用者・代理店一覧を取得する（agency では依存 API を一切呼ばない）。
  useEffect(() => {
    if (!isOperator) return;
    let active = true;
    void (async () => {
      const [usersResult, agenciesResult] = await Promise.all([getDashboardUsers(), getAgencies()]);
      if (!active) return;
      if (agenciesResult.ok) setAgencies(agenciesResult.value);
      if (usersResult.ok) setList({ kind: 'ready', users: usersResult.value });
      else setList({ kind: 'error', message: usersResult.message });
    })();
    return () => {
      active = false;
    };
  }, [isOperator]);

  // 代理店 id → 代理店名の索引（一覧の所属代理店表示に使う）。
  const agencyNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agency of agencies) map.set(agency.id, agency.name);
    return map;
  }, [agencies]);

  // 非 operator には管理情報・登録手段を一切描画しない（Req 6.5）。
  if (!isOperator) {
    return (
      // 分岐ごとに版面を変えない（同じ面が分岐で別の幅に見えると、どちらが本来か読めなくなる）。
      // 主要領域はここでも 1 つである（下の return と排他）。
      <PageShell width="lg" className="flex flex-col gap-6">
        <Heading level={1}>利用者管理</Heading>
        {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねない。 */}
        <Alert variant="destructive">
          <AlertDescription>この画面は運営のみ利用できます。</AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  // 利用者一覧を取り直す（登録・無効化後の反映に使う）。
  async function reloadUsers() {
    const result = await getDashboardUsers();
    if (result.ok) setList({ kind: 'ready', users: result.value });
    else setList({ kind: 'error', message: result.message });
  }

  // 利用者登録（Req 6.2, 6.3）。role=代理店 のときのみ agencyId を必須とし送出、role=運営 では送らない。
  async function handleCreate() {
    setFormError(null);
    const trimmedEmail = email.trim();
    if (trimmedEmail === '') {
      setFormError('メールアドレスを入力してください。');
      return;
    }
    if (role === 'agency' && agencyId === '') {
      setFormError('所属代理店を選択してください。');
      return;
    }
    const trimmedDisplayName = displayName.trim();
    setSubmitting(true);
    const result = await createDashboardUser({
      role,
      // 代理店ロールのみ agencyId を送る（運営ロールでは送らない・ck_dashboard_role_scope・Req 6.3）。
      ...(role === 'agency' ? { agencyId } : {}),
      email: trimmedEmail,
      ...(trimmedDisplayName !== '' ? { displayName: trimmedDisplayName } : {}),
    });
    setSubmitting(false);
    if (result.ok) {
      setEmail('');
      setDisplayName('');
      setAgencyId('');
      await reloadUsers();
    } else if (result.code === 'email_conflict_disabled') {
      // 自運営配下の無効化済み利用者との衝突は、新規登録ではなく有効化で復旧する（Req 3.2）。
      setFormError(
        'このメールアドレスは無効化済みの利用者です。利用者一覧から有効化してください。',
      );
    } else if (result.code === 'email_conflict') {
      setFormError('既に登録済みのメールアドレスです。');
    } else if (result.code === 'validation_failed') {
      setFormError('入力内容を確認してください（ロールと所属代理店・メールアドレスの形式）。');
    } else {
      setFormError('利用者の登録に失敗しました。時間をおいて再試行してください。');
    }
  }

  // 無効化（Req 6.4）。成功時は一覧を取り直して当該行を無効表示にする。
  // ガード拒否（自己無効化・最後の運営）は成功と誤認させない専用文言で表示し、対象状態は変えない（Req 2.6）。
  async function handleDisable(id: string) {
    setActionError(null);
    const result = await disableDashboardUser({ id });
    if (result.ok) {
      await reloadUsers();
    } else if (result.code === 'self_disable_forbidden') {
      setActionError('自分自身は無効化できません。');
    } else if (result.code === 'last_operator') {
      setActionError('最後の運営は無効化できません。先に別の運営を追加してください。');
    } else {
      setActionError('無効化に失敗しました。時間をおいて再試行してください。');
    }
  }

  // 再有効化（Req 1.6）。成功時は一覧を取り直して当該行を有効表示にする。
  async function handleEnable(id: string) {
    setActionError(null);
    const result = await enableDashboardUser({ id });
    if (result.ok) {
      await reloadUsers();
    } else {
      setActionError('有効化に失敗しました。時間をおいて再試行してください。');
    }
  }

  return (
    // 一覧が主の面なので版面は広い側を使う。既存の main を **置換** する（入れ子にしない）。
    <PageShell width="lg" className="flex flex-col gap-6">
      <Heading level={1}>利用者管理</Heading>

      <FieldGroup>
        {/* **段落ではなく汎用の容器で包む。** 選択の部品は開閉の記号を重ねるために div を
          * 1 枚挟むので、段落の直下には置けない。置くとブラウザの構文解析が段落を早期に閉じ、
          * サーバ描画とクライアント描画の木が食い違う。
          * 幅の制約は広い版面でだけ効かせる（携帯端末幅の実測を動かさないため）。値は
          * task 2.4 が招待コード・代理店管理で採った段と同一である（Req 1.2）。 */}
        <Field className="contents">
          <div className="flex flex-col gap-2 sm:max-w-xs">
            <Label htmlFor="user-role">ロール</Label>
            {/* 標準の選択要素のラッパである。id・value・onChange はいずれも選択要素へ透過し、
              * ラベルとの関連付けもプログラムによる値の変更もそのまま働く（Req 3.4）。 */}
            <Select
              id="user-role"
              value={role}
              onChange={(event) => setRole(event.target.value as DashboardRole)}
            >
              <option value="operator">運営</option>
              <option value="agency">代理店</option>
            </Select>
          </div>
        </Field>

        {/* 代理店ロールのときのみ所属代理店を必須で入力させる。運営ロールでは代理店欄を出さない（Req 6.3） */}
        {role === 'agency' && (
          <Field className="contents">
            <div className="flex flex-col gap-2 sm:max-w-xs">
              <Label htmlFor="user-agency">所属代理店</Label>
              {/* 必須属性は包む要素ではなく選択要素そのものへ載る（部品が props を透過するため）。 */}
              <Select
                id="user-agency"
                required
                value={agencyId}
                onChange={(event) => setAgencyId(event.target.value)}
              >
                <option value="">代理店を選択してください</option>
                {agencies.map((agency) => (
                  <option key={agency.id} value={agency.id}>
                    {agency.name}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
        )}

        <Field className="contents">
          <div className="flex flex-col gap-2 sm:max-w-xs">
            <Label htmlFor="user-email">メールアドレス</Label>
            <Input
              id="user-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
        </Field>

        <Field className="contents">
          <div className="flex flex-col gap-2 sm:max-w-xs">
            <Label htmlFor="user-display-name">表示名</Label>
            <Input
              id="user-display-name"
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
        </Field>

        {/* 版面は縦の flex なので、そのまま置くと押しボタンが行幅いっぱいに伸びる。
          * 主操作を全幅にするのはログイン画面の判断（正典 7.9）であってこの面の判断ではない。
          * 無効の通知手段は変えない（素の無効属性のまま。焦点の到達を要求する箇所とは別枠）。 */}
        <Button
          type="button"
          className="self-start"
          onClick={() => void handleCreate()}
          disabled={submitting}
        >
          利用者登録
        </Button>
      </FieldGroup>

      {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねると
        * 領域が二重になるため、文言は説明の受け口へ置くだけにする。 */}
      {formError !== null && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
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

      {list.kind === 'ready' && list.users.length === 0 && (
        <EmptyState>
          <p>利用者はまだいません。登録してください。</p>
        </EmptyState>
      )}

      {list.kind === 'ready' && list.users.length > 0 && (
        // 横方向の捲りは表の **外側** が持つ。この容器は e2e（dashboard-surfaces.spec.ts）が
        // 宣言する「表の捲れる領域 1 件」である。
        <TableContainer label="利用者一覧">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>ロール</TableHeaderCell>
                <TableHeaderCell>メールアドレス</TableHeaderCell>
                <TableHeaderCell>所属代理店</TableHeaderCell>
                <TableHeaderCell>状態</TableHeaderCell>
                <TableHeaderCell>操作</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {list.users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>{roleLabel(user.role)}</TableCell>
                  <TableCell>{user.email ?? '—'}</TableCell>
                  {/* 運営ロールは所属代理店を持たない（agencyId=null）。 */}
                  <TableCell>
                    {user.agencyId === null ? '—' : agencyNameById.get(user.agencyId) ?? user.agencyId}
                  </TableCell>
                  {/* 有効/無効の状態（Req 6.4）。招待コードの同じ列と同じく素の語のまま置く。
                    * 装飾で包むと同一役割が面をまたいで 2 通りに描かれ、Req 1.2 が壊れる。 */}
                  <TableCell>{user.disabled ? '無効' : '有効'}</TableCell>
                  <TableCell>
                    {/* 無効化済み行には有効化ボタンを提供する（Req 1.6・API は冪等） */}
                    {user.disabled && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleEnable(user.id)}
                      >
                        有効化
                      </Button>
                    )}
                    {/* 無効化は有効な利用者にのみ提供し、自分自身の行には出さない（Req 6.4, 2.2） */}
                    {!user.disabled && user.id !== me?.id && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleDisable(user.id)}
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
    </PageShell>
  );
}

// 利用者管理（運営専用）。認可ガードで囲い、共通ナビを添える。全文言日本語（Req 7.3）。
export default function AdminUsersPage() {
  return (
    <AuthGuard>
      <TopNav />
      <UsersView />
    </AuthGuard>
  );
}

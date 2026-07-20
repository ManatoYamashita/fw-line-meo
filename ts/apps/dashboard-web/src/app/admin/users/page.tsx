'use client';

import { useEffect, useMemo, useState } from 'react';
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
      <main>
        <h1>利用者管理</h1>
        <p role="alert">この画面は運営のみ利用できます。</p>
      </main>
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
    <main>
      <h1>利用者管理</h1>

      <div>
        <p>
          <label htmlFor="user-role">ロール</label>
          <select
            id="user-role"
            value={role}
            onChange={(event) => setRole(event.target.value as DashboardRole)}
          >
            <option value="operator">運営</option>
            <option value="agency">代理店</option>
          </select>
        </p>

        {/* 代理店ロールのときのみ所属代理店を必須で入力させる。運営ロールでは代理店欄を出さない（Req 6.3） */}
        {role === 'agency' && (
          <p>
            <label htmlFor="user-agency">所属代理店</label>
            <select
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
            </select>
          </p>
        )}

        <p>
          <label htmlFor="user-email">メールアドレス</label>
          <input
            id="user-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </p>

        <p>
          <label htmlFor="user-display-name">表示名</label>
          <input
            id="user-display-name"
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </p>

        <button type="button" onClick={() => void handleCreate()} disabled={submitting}>
          利用者登録
        </button>
      </div>

      {formError !== null && <p role="alert">{formError}</p>}
      {actionError !== null && <p role="alert">{actionError}</p>}

      {list.kind === 'loading' && <p>読み込み中...</p>}
      {list.kind === 'error' && <p role="alert">{list.message}</p>}

      {list.kind === 'ready' && list.users.length === 0 && (
        <p>利用者はまだいません。登録してください。</p>
      )}

      {list.kind === 'ready' && list.users.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>ロール</th>
              <th>メールアドレス</th>
              <th>所属代理店</th>
              <th>状態</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.users.map((user) => (
              <tr key={user.id}>
                <td>{roleLabel(user.role)}</td>
                <td>{user.email ?? '—'}</td>
                {/* 運営ロールは所属代理店を持たない（agencyId=null）。 */}
                <td>{user.agencyId === null ? '—' : agencyNameById.get(user.agencyId) ?? user.agencyId}</td>
                {/* 有効/無効バッジ（Req 6.4） */}
                <td>{user.disabled ? '無効' : '有効'}</td>
                <td>
                  {/* 無効化済み行には有効化ボタンを提供する（Req 1.6・API は冪等） */}
                  {user.disabled && (
                    <button type="button" onClick={() => void handleEnable(user.id)}>
                      有効化
                    </button>
                  )}
                  {/* 無効化は有効な利用者にのみ提供し、自分自身の行には出さない（Req 6.4, 2.2） */}
                  {!user.disabled && user.id !== me?.id && (
                    <button type="button" onClick={() => void handleDisable(user.id)}>
                      無効化
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
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

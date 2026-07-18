'use client';

import { useEffect, useState } from 'react';
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
      <main>
        <h1>代理店管理</h1>
        <p role="alert">この画面は運営のみ利用できます。</p>
      </main>
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
    <main>
      <h1>代理店管理</h1>

      <div>
        <label htmlFor="agency-name">代理店名</label>
        <input
          id="agency-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="button" onClick={() => void handleCreate()} disabled={submitting}>
          代理店作成
        </button>
      </div>

      {formError !== null && <p role="alert">{formError}</p>}

      {list.kind === 'loading' && <p>読み込み中...</p>}
      {list.kind === 'error' && <p role="alert">{list.message}</p>}

      {list.kind === 'ready' && list.agencies.length === 0 && (
        <p>代理店はまだありません。作成してください。</p>
      )}

      {list.kind === 'ready' && list.agencies.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>代理店名</th>
              <th>作成日時</th>
            </tr>
          </thead>
          <tbody>
            {list.agencies.map((agency) => (
              <tr key={agency.id}>
                <td>{agency.name}</td>
                <td>{agency.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
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

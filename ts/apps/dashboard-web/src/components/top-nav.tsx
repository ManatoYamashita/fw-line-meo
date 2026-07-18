'use client';

import Link from 'next/link';
import { useAuth } from '../lib/auth-context';

// 共通トップナビ（日本語 UI・Req 7.3）。ログアウト導線を常設し、管理メニュー（代理店管理・利用者管理）は
// operator ロールのみ表示する（agency には非表示。ただし表示制御は利便性であり防御ではない。
// 実際の認可は dashboard-api 側で行う）。管理画面本体は Task 4.5 で追加する。
export function TopNav() {
  const { status, me, signOut } = useAuth();

  // 未認証・未登録・読み込み中はナビを出さない（管理導線を露出しない）。
  if (status !== 'ready' || me === null) {
    return null;
  }

  const isOperator = me.role === 'operator';

  return (
    <nav aria-label="メインナビゲーション">
      <ul>
        <li>
          <Link href="/stores">店舗一覧</Link>
        </li>
        <li>
          <Link href="/stores/new">店舗登録</Link>
        </li>
        <li>
          <Link href="/invite-codes">招待コード</Link>
        </li>
        {isOperator && (
          <li>
            <Link href="/admin/agencies">代理店管理</Link>
          </li>
        )}
        {isOperator && (
          <li>
            <Link href="/admin/users">利用者管理</Link>
          </li>
        )}
      </ul>
      <button type="button" onClick={() => void signOut()}>
        ログアウト
      </button>
    </nav>
  );
}

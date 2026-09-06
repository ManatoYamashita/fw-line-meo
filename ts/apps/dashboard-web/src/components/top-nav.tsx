'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Badge } from '@fwlm/ui/components/badge';
import { Button } from '@fwlm/ui/components/button';
import type { DashboardRole } from '../lib/api';
import { useAuth } from '../lib/auth-context';

// 帯に並べる案内リンク。読み上げ名と順序は素の要素で書いていたときの描画と同一で、
// 管理メニュー（代理店管理・利用者管理）だけを operatorOnly で分ける。
// 表示制御は利便性であり防御ではない（実際の認可は dashboard-api 側で行う・Req 6.5）。
const NAV_ITEMS: readonly { href: string; label: string; operatorOnly: boolean }[] = [
  { href: '/stores', label: '店舗一覧', operatorOnly: false },
  { href: '/stores/new', label: '店舗登録', operatorOnly: false },
  { href: '/invite-codes', label: '招待コード', operatorOnly: false },
  { href: '/admin/agencies', label: '代理店管理', operatorOnly: true },
  { href: '/admin/users', label: '利用者管理', operatorOnly: true },
];

// 案内リンクの class。現在地のリンクも含めて全リンクで完全に同一であり、下線は aria-current 属性から
// のみ発火する。docs/design/design-language.md の 7.8 節が「下線とこの属性は同じ判定から出し、
// 片方だけが付く状態を作らない」と定めており、条件分岐を class 側に持たないことで構造的にそれを満たす。
// 罫の色は currentColor（リンク自身の文字色）を借りるため、面の側に置く色を 1 件も増やさない。
const NAV_LINK_CLASS =
  'inline-flex items-center border-b-2 border-transparent py-2 text-sm font-medium whitespace-nowrap aria-[current=page]:border-current';

// ロール表示名（日本語・Req 7.3）。利用者管理画面にも同義の関数があるが、面をまたぐ共通化は
// 本タスクの境界外であり、語彙だけを揃える。
function roleLabel(role: DashboardRole): string {
  return role === 'operator' ? '運営' : '代理店';
}

// 共通トップナビ（日本語 UI・Req 7.3）。ログアウト導線を常設し、管理メニューは operator ロールのみ表示する。
// 帯の高さ・現在地の示し方・ワードマークの色は docs/design/design-language.md（7.4 / 7.8 / 10 節）が正典で、
// ここでは結論も数値も転記せず参照する。
export function TopNav() {
  const { status, me, signOut } = useAuth();
  const pathname = usePathname();

  // 未認証・未登録・読み込み中はナビを出さない（管理導線を露出しない）。
  if (status !== 'ready' || me === null) {
    return null;
  }

  const isOperator = me.role === 'operator';
  const items = NAV_ITEMS.filter((item) => !item.operatorOnly || isOperator);

  return (
    <nav aria-label="メインナビゲーション" className="flex h-20 items-center gap-6 border-b border-border px-6">
      {/* ワードマーク。装飾専用色の使い所をここへ限る判断は 7.4 節、大きい文字としてのみ用いる根拠は
          10 節にある。リンクにも見出しにもしない（リンクの個数を固定した構造契約・Req 3.3）。 */}
      <span className="text-2xl font-bold text-brand">LINE MEO</span>
      {/* 幅が足りないときの溢れはリストの内部へ閉じ、ページ全体を横に溢れさせない（Req 4.6）。 */}
      <ul className="flex min-w-0 flex-1 items-center gap-6 overflow-x-auto">
        {items.map((item) => (
          <li key={item.href}>
            {/* 現在地の判定は経路の完全一致で行う。前方一致にすると /stores/new で /stores も
                現在地になり、印が 1 つという一意性が壊れる。 */}
            <Link
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
              className={NAV_LINK_CLASS}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
      <Badge variant="secondary">{roleLabel(me.role)}</Badge>
      <Button type="button" variant="ghost" onClick={() => void signOut()}>
        ログアウト
      </Button>
    </nav>
  );
}

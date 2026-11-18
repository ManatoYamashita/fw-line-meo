'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { textLinkVariants } from '@fwlm/ui/components/text-link';
import { useAuth } from '../lib/auth-context';
import { agencyPath } from '../lib/entity-paths';

// 一覧の表の名前から詳細へ進む導線（agency-dashboard Requirement 10・Issue #526）。
//
// 名前の表示（「（表示名なし）」など）は呼び出し側が決めて children に渡す。見た目は文字のリンク
// （textLinkVariants・下線・§7.21）に揃え、行全体は押せるようにしない（§7.2）。
// 停止中の店舗・表示名の無いオーナー・連携を解除したオーナーも、状態にかかわらず同じリンクにする（10.6）。
// 状態は詳細の画面の側で示す。

export interface EntityLinkProps {
  /** 経路（entity-paths.ts の storePath・ownerPath・agencyPath で組み立てる）。 */
  href: string;
  children: ReactNode;
}

/** 詳細の画面への文字のリンク（Req 10.1・10.2・10.8）。 */
export function EntityLink({ href, children }: EntityLinkProps) {
  return (
    <Link href={href} className={textLinkVariants()}>
      {children}
    </Link>
  );
}

export interface AgencyNameProps {
  agencyId: string;
  name: string;
}

/**
 * 代理店名。運営には代理店の詳細へのリンクとして、それ以外には素の文字として描く（Req 10.3・10.4）。
 * 代理店の詳細は運営専用（Req 9.9）なので、代理店ロールには導線を出さない。利用者の情報が
 * まだ無いあいだも、運営と確かめられるまでリンクにしない。
 */
export function AgencyName({ agencyId, name }: AgencyNameProps) {
  const { me } = useAuth();
  if (me?.role !== 'operator') return <>{name}</>;
  return <EntityLink href={agencyPath(agencyId)}>{name}</EntityLink>;
}

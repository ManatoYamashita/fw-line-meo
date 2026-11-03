import { AuthGuard } from '../../../../components/auth-guard';
import { TopNav } from '../../../../components/top-nav';
import { AgencyDetailView } from './agency-detail-view';

// 代理店ごとの詳細（運営専用・Issue #486・agency-dashboard Requirement 9）。dashboard-web で最初の動的ルート。
//
// サーバー部品のまま経路の引数（Next.js 16 では Promise）を受け、代理店 id を文字列で渡す。取得はクライアント部品が
// 行う（API は別オリジンで、Firebase の ID トークンをクライアントが付ける）。generateStaticParams は持たない。
export default async function AgencyDetailPage({ params }: PageProps<'/admin/agencies/[agencyId]'>) {
  const { agencyId } = await params;
  return (
    <AuthGuard>
      <TopNav />
      <AgencyDetailView agencyId={agencyId} />
    </AuthGuard>
  );
}

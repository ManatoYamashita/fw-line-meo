import { AuthGuard } from '../../../components/auth-guard';
import { TopNav } from '../../../components/top-nav';
import { OwnerDetailView } from './owner-detail-view';

// オーナーの詳細（agency-dashboard Requirement 11・Issue #526）。店舗の詳細・代理店の詳細（Issue #486）と同じく、
// サーバー部品のまま経路の引数（Next.js 16 では Promise）を受け、オーナー id を文字列で渡す。取得はクライアント部品が
// 行う（API は別オリジンで、Firebase の ID トークンをクライアントが付ける）。generateStaticParams は持たない。
export default async function OwnerDetailPage({ params }: PageProps<'/owners/[ownerId]'>) {
  const { ownerId } = await params;
  return (
    <AuthGuard>
      <TopNav />
      <OwnerDetailView ownerId={ownerId} />
    </AuthGuard>
  );
}

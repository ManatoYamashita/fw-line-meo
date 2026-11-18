import { AuthGuard } from '../../../components/auth-guard';
import { TopNav } from '../../../components/top-nav';
import { StoreDetailView } from './store-detail-view';

// 店舗の詳細（agency-dashboard Requirement 11・Issue #526）。代理店詳細（Issue #486）と同じく、サーバー部品のまま
// 経路の引数（Next.js 16 では Promise）を受け、店舗 id を文字列で渡す。取得はクライアント部品が行う
// （API は別オリジンで、Firebase の ID トークンをクライアントが付ける）。generateStaticParams は持たない。
// `/stores/new` は静的な経路なのでこの動的な経路より先に選ばれる。
export default async function StoreDetailPage({ params }: PageProps<'/stores/[storeId]'>) {
  const { storeId } = await params;
  return (
    <AuthGuard>
      <TopNav />
      <StoreDetailView storeId={storeId} />
    </AuthGuard>
  );
}

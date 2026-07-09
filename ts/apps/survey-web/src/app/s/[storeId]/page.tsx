import { getPool, findStoreForSurvey, listSurveyAspects } from '@fwlm/db';
import { buildGoogleReviewUrl } from '../../../lib/google-review-url';
import { createSessionTokenService } from '../../../lib/session-token';
import { loadSurveyPageData, type SurveyPageDeps } from './page-data';
import { SurveyShell } from './survey-shell';

// pg / token 署名のため Node ランタイム・動的（毎回 store を DB から読む）。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function buildDeps(): Promise<SurveyPageDeps> {
  const signingKey = process.env.SESSION_SIGNING_KEY;
  if (!signingKey) throw new Error('SESSION_SIGNING_KEY is required');
  const tokens = createSessionTokenService(signingKey);
  return {
    findStore: async (id) => findStoreForSurvey(await getPool(), id),
    listAspects: async () => listSurveyAspects(await getPool()),
    signPage: (storeId) => tokens.signPage(storeId),
    buildReviewUrl: (placeId) => buildGoogleReviewUrl(placeId),
  };
}

export default async function SurveyPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}): Promise<React.ReactElement> {
  const { storeId } = await params;
  const data = await loadSurveyPageData(await buildDeps(), storeId);

  if (data.kind === 'unavailable') {
    return (
      <main>
        <p>このアンケートは現在ご利用いただけません。</p>
      </main>
    );
  }

  return (
    <main>
      <SurveyShell
        storeId={data.store.id}
        storeName={data.store.name}
        aspects={data.aspects}
        pageToken={data.pageToken}
        googleReviewUrl={data.googleReviewUrl}
      />
    </main>
  );
}

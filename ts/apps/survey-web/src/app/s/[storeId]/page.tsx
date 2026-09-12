import { getPool, findStoreForSurvey, listSurveyAspects } from '@fwlm/db';
import { headers } from 'next/headers';
import { correlationIdFromHeaders, withCorrelation } from '@fwlm/observability';
import { Heading } from '@fwlm/ui/components/heading';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { buildGoogleReviewUrl } from '../../../lib/google-review-url';
import { createSessionTokenService } from '../../../lib/session-token';
import { writeStructuredLog } from '../../../lib/structured-log';
import { loadSurveyPageData, type SurveyPageDeps } from './page-data';
import { SurveyShell } from './survey-shell';

// pg / token 署名のため Node ランタイム・動的（毎回 store を DB から読む）。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requestCorrelationId(): Promise<string | undefined> {
  try {
    // Next.js の request scope がある実リクエストでは Cloud Run の trace を取得する。
    // 単体テストなど request scope 外の呼び出しでは、観測用情報を付けずに描画を続ける。
    return correlationIdFromHeaders(await headers());
  } catch {
    return undefined;
  }
}

async function buildDeps(): Promise<SurveyPageDeps> {
  const signingKey = process.env.SESSION_SIGNING_KEY;
  if (!signingKey) throw new Error('SESSION_SIGNING_KEY is required');
  const tokens = createSessionTokenService(signingKey);
  const correlationId = await requestCorrelationId();
  return {
    findStore: async (id) => findStoreForSurvey(await getPool(), id),
    listAspects: async () => listSurveyAspects(await getPool()),
    signPage: (storeId) => tokens.signPage(storeId),
    buildReviewUrl: (placeId) => buildGoogleReviewUrl(placeId),
    log: withCorrelation(writeStructuredLog, correlationId),
  };
}

export default async function SurveyPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}): Promise<React.ReactElement> {
  const { storeId } = await params;
  const data = await loadSurveyPageData(await buildDeps(), storeId);

  // 版面は外枠の部品が持つ（幅・左右余白・上下余白）。この面は本文系なので狭い方の段を使う。
  // 分岐ごとに余白を変えていたが、面の側で段を作る理由が無いため部品の値へ寄せる。
  // 部品は主要領域（main）として描かれるため、入れ子にしないこと。
  if (data.kind === 'unavailable') {
    return (
      <PageShell width="sm">
        <p className="text-muted-foreground">このアンケートは現在ご利用いただけません。</p>
      </PageShell>
    );
  }

  return (
    <PageShell width="sm">
      {/* 店名の見出し。どの店舗へのアンケートかを回答前に示す（従来は完了画面にしか出ていなかった）。 */}
      <Heading className="mb-8" level={1}>
        {data.store.name}
      </Heading>
      <SurveyShell
        storeId={data.store.id}
        storeName={data.store.name}
        aspects={data.aspects}
        pageToken={data.pageToken}
        googleReviewUrl={data.googleReviewUrl}
      />
    </PageShell>
  );
}

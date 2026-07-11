'use client';

import { useEffect, useState } from 'react';
import { SurveyForm } from './survey-form';
import { DraftPanel } from './draft-panel';
import { isRecentlyAnswered, markAnswered } from './answered-flag';
import type { AspectOption, SurveyAnswer } from './types';

// クライアント合成シェル（統合の中心）。回答フェーズと結果 state を所有し、
// /api/responses・/api/drafts を呼び出して SurveyForm / DraftPanel に props を渡す。
// localStorage の回答済み判定はクライアント側で行う（SSR からは読めないため）。

interface Props {
  storeId: string;
  storeName: string;
  aspects: AspectOption[];
  pageToken: string;
  googleReviewUrl: string;
}

type Phase = 'answering' | 'drafting' | 'answered';

interface DraftState {
  draft: string;
  sessionToken: string;
  regenerationsLeft: number;
  generationFailed: boolean;
}

interface ApiResult {
  generation?: 'ok' | 'failed';
  draft?: string | null;
  sessionToken?: string;
  regenerationsLeft?: number;
}

export function SurveyShell({ storeId, storeName, aspects, pageToken, googleReviewUrl }: Props) {
  const [phase, setPhase] = useState<Phase>('answering');
  const [submitting, setSubmitting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isRecentlyAnswered(storeId)) setPhase('answered');
  }, [storeId]);

  async function handleSubmit(answer: SurveyAnswer): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageToken, storeId, ...answer }),
      });
      const json = (await res.json()) as ApiResult;
      if (!res.ok) {
        setError('送信に失敗しました。時間をおいて再度お試しください。');
        return;
      }
      markAnswered(storeId);
      setDraftState({
        draft: json.draft ?? '',
        sessionToken: json.sessionToken ?? '',
        regenerationsLeft: json.regenerationsLeft ?? 0,
        generationFailed: json.generation === 'failed',
      });
      setPhase('drafting');
    } catch {
      setError('通信に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegenerate(): Promise<void> {
    if (!draftState) return;
    setRegenerating(true);
    try {
      const res = await fetch('/api/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: draftState.sessionToken }),
      });
      const json = (await res.json()) as ApiResult;
      if (!res.ok) return; // 上限(409)等は現状の下書き・残数を維持
      setDraftState({
        draft: json.draft ?? draftState.draft,
        sessionToken: json.sessionToken ?? draftState.sessionToken,
        regenerationsLeft: json.regenerationsLeft ?? draftState.regenerationsLeft,
        generationFailed: json.generation === 'failed',
      });
    } catch {
      // 通信失敗時は現状維持（投稿導線は残る）
    } finally {
      setRegenerating(false);
    }
  }

  if (phase === 'answered') {
    return (
      <section>
        <p>{storeName}へのご回答ありがとうございました。</p>
        <a href={googleReviewUrl} target="_blank" rel="noopener noreferrer">
          Google のクチコミを書く
        </a>
      </section>
    );
  }

  if (phase === 'drafting' && draftState) {
    return (
      <DraftPanel
        draft={draftState.draft}
        generationFailed={draftState.generationFailed}
        regenerationsLeft={draftState.regenerationsLeft}
        googleReviewUrl={googleReviewUrl}
        onRegenerate={handleRegenerate}
        regenerating={regenerating}
      />
    );
  }

  return (
    <>
      {error !== null && <p role="alert">{error}</p>}
      <SurveyForm aspects={aspects} onSubmit={handleSubmit} submitting={submitting} />
    </>
  );
}

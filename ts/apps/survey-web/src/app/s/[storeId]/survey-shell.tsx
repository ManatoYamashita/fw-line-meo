'use client';

import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { buttonVariants } from '@fwlm/ui/components/button';
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
      <section className="space-y-4">
        {/* 回答が届いたことの通知。読み上げ役割（穏やかなライブリージョン）は変種から部品が
            決める。面の側で役割を手書きすると、部品の分岐と二重管理になる。
            下書きパネルのような常時マウントの容器は要らない。あちらは同じ画面の中で通知だけが
            現れたり消えたりするが、こちらは画面そのものが分岐で切り替わるためである。 */}
        <Alert variant="success">
          <AlertDescription>{storeName}へのご回答ありがとうございました。</AlertDescription>
        </Alert>
        {/* 投稿導線（全評価で同一。ゲーティングをしない）。
            要素はリンクのまま、見た目だけを押しボタンの部品から借りる（正典 7.9 / 7.10）。
            部品そのものを使わないのは、押しボタンとして描くと支援技術に押しボタンとして読まれ、
            遷移であることが伝わらなくなるためである。寸法の実値はここに書かない。

            **下書きパネルの投稿導線と同一の呼び出しにする。** 共有モジュールへ切り出さないのは、
            回答済み画面と下書きパネルが別々の境界を持つ面だからである。切り出す代わりに、
            2 箇所が食い違わないことを検証が機械強制する
            （`test/survey-shell.test.tsx` の「面をまたいだ相等」。期待値は部品の算出結果から
            取るので、片方だけを直す改変も、部品の側の変更に片方だけ追随する改変も落ちる）。 */}
        <a
          className={buttonVariants({ variant: 'outline', size: 'lg', className: 'w-full' })}
          href={googleReviewUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
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
      {error !== null && (
        // 読み上げ役割（進行中の読み上げを中断するライブリージョン）は変種から部品が決める。
        // 面の側で役割を手書きすると、部品の分岐と二重管理になる。
        // 下の余白だけは面の側に残す。フォームとの間隔は外側の律であって、通知の部品の領分では
        // ないためである（正典 7.10 が面の側に禁じたのは高さ・内側余白・文字寸法）。
        <Alert className="mb-4" variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <SurveyForm aspects={aspects} onSubmit={handleSubmit} submitting={submitting} />
    </>
  );
}

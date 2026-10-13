'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from '@fwlm/ui/components/app-toaster';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { buttonVariants } from '@fwlm/ui/components/button';
import { cn } from '@fwlm/ui/lib/utils';
import type { StructuredSurveyDefinition } from '@fwlm/db';
import { SurveyForm } from './survey-form';
import { StructuredSurveyForm } from './structured-survey-form';
import { DraftPanel } from './draft-panel';
import { isRecentlyAnswered, markAnswered } from './answered-flag';
import { notifyReviewLinkOpened } from '../../../lib/review-link-beacon';
import type { AspectOption, SurveyAnswer } from './types';
import type { StructuredSurveyAnswer } from '../../../lib/structured-answer';

// クライアント合成シェル（統合の中心）。回答フェーズと結果 state を所有し、
// /api/responses・/api/drafts を呼び出して SurveyForm / DraftPanel に props を渡す。
// localStorage の回答済み判定はクライアント側で行う（SSR からは読めないため）。
//
// legacy と structured（Issue #438）は店舗の設定で分岐し、ここではフォームだけを切り替える。回答済みの判定・
// 下書き・再生成・投稿導線・押下の通知は両方で共有する。structured の回答には Stage 2 では下書きを作らないので
// （Issue #439 で実装する）、受付の後は回答済みの画面（Google の投稿導線）へ進む。

/** 店舗の種類ごとのフォームの入力。legacy は従来の観点、structured は店舗別の定義。 */
export type SurveyKind =
  | { mode: 'legacy'; aspects: AspectOption[] }
  | { mode: 'structured'; definition: StructuredSurveyDefinition };

interface Props {
  storeId: string;
  storeName: string;
  survey: SurveyKind;
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
  mode?: 'structured';
  generation?: 'ok' | 'failed' | 'unavailable';
  draft?: string | null;
  sessionToken?: string;
  regenerationsLeft?: number;
  supportCode?: string;
  error?: { code?: string; message?: string };
}

function apiErrorMessage(json: ApiResult, fallback: string): string {
  const message = json.error?.message ?? fallback;
  return json.supportCode ? `${message}（サポートコード: ${json.supportCode}）` : message;
}

export function SurveyShell({ storeId, storeName, survey, pageToken, googleReviewUrl }: Props) {
  const [phase, setPhase] = useState<Phase>('answering');
  const [submitting, setSubmitting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 表示の後にアンケートの内容が変わった（Issue #438・STALE_SURVEY）。通常の失敗と区別し、再読み込みを案内する。
  const [stale, setStale] = useState(false);
  // 投稿導線の押下を通知済みか（Issue #401・Requirement 5.10）。1 回の画面表示につき最初の押下だけを
  // 通知する。通知は無状態で、同じ token を何度送ってもサーバーは区別できない。連打や再生成の後の
  // 押し直しを数えると、QR パネルに出す「投稿画面へ進んだ回数」が同じ客の分だけ膨らむ。
  // 印は ref に持ち、端末に保存しない。localStorage に残すと、再訪を識別できる値になる。
  // 描画に使わない値なので state にしない（押下で再描画を起こさない）。
  const reviewLinkNotifiedRef = useRef(false);
  const submittingRef = useRef(false);
  const answerSubmittedRef = useRef(false);
  const regeneratingRef = useRef(false);

  function notifyReviewLinkOnce(token: string): void {
    if (reviewLinkNotifiedRef.current) return;
    reviewLinkNotifiedRef.current = true;
    notifyReviewLinkOpened(storeId, token);
  }

  useEffect(() => {
    if (isRecentlyAnswered(storeId)) setPhase('answered');
  }, [storeId]);

  async function handleSubmit(answer: SurveyAnswer | StructuredSurveyAnswer): Promise<void> {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setStale(false);
    try {
      const res = await fetch('/api/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageToken, storeId, ...answer }),
      });
      const json = (await res.json()) as ApiResult;
      if (!res.ok) {
        if (json.error?.code === 'STALE_SURVEY') setStale(true);
        const message = apiErrorMessage(json, '送信に失敗しました。時間をおいて再度お試しください。');
        setError(message);
        toast.error(message);
        return;
      }
      answerSubmittedRef.current = true;
      markAnswered(storeId);
      if (json.mode === 'structured' && json.generation === 'unavailable') {
        // structured の回答には Stage 2 では下書きを作らない（Issue #439 で実装）。回答済みの画面へ進み、
        // Google の投稿導線を出す（全評価で同一）。
        setPhase('answered');
        toast.success('回答を送信しました。');
        return;
      }
      setDraftState({
        draft: json.draft ?? '',
        sessionToken: json.sessionToken ?? '',
        regenerationsLeft: json.regenerationsLeft ?? 0,
        generationFailed: json.generation === 'failed',
      });
      setPhase('drafting');
      if (json.generation === 'failed') toast.error('下書きの生成に失敗しました。もう一度生成するか、そのまま投稿画面へお進みください。');
      else toast.success('口コミ文を作成しました。');
    } catch {
      const message = '通信に失敗しました。入力内容は残っています。時間をおいて再度お試しください。';
      setError(message);
      toast.error(message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleRegenerate(): Promise<void> {
    if (!draftState || regeneratingRef.current) return;
    regeneratingRef.current = true;
    setRegenerating(true);
    setError(null);
    try {
      const res = await fetch('/api/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: draftState.sessionToken }),
      });
      const json = (await res.json()) as ApiResult;
      if (!res.ok) {
        const message = apiErrorMessage(json, '再生成に失敗しました。時間をおいて再度お試しください。');
        setError(message);
        toast.error(message);
        return;
      }
      setDraftState({
        draft: json.draft ?? draftState.draft,
        sessionToken: json.sessionToken ?? draftState.sessionToken,
        regenerationsLeft: json.regenerationsLeft ?? draftState.regenerationsLeft,
        generationFailed: json.generation === 'failed',
      });
      if (json.generation === 'failed') toast.error('下書きの生成に失敗しました。もう一度生成するか、そのまま投稿画面へお進みください。');
      else toast.success('別の口コミ文を作成しました。');
    } catch {
      const message = '通信に失敗しました。文章は残っています。時間をおいて再度お試しください。';
      setError(message);
      toast.error(message);
    } finally {
      regeneratingRef.current = false;
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
        <Alert variant="success" role={answerSubmittedRef.current ? undefined : 'status'}>
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
            取るので、片方だけを直す改変も、部品の側の変更に片方だけ追随する改変も落ちる）。

            押下の通知には pageToken を載せる（Issue #137）。回答済み画面には sessionToken が無い
            （回答の中身を封入しているので端末に残さない）。pageToken が証明するのは「ページが
            配信された」ことまでで、信頼水準は表示件数と同じである（design.md の ReviewLinkAPI）。 */}
        <a
          className={cn(buttonVariants({ variant: 'outline', size: 'lg', className: 'w-full' }))}
          href={googleReviewUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => notifyReviewLinkOnce(pageToken)}
        >
          Google のクチコミを書く
        </a>
      </section>
    );
  }

  if (phase === 'drafting' && draftState) {
    return (
      <>
      {error === null ? null : <Alert variant="destructive" role={undefined}><AlertDescription>{error}</AlertDescription></Alert>}
      <DraftPanel
        draft={draftState.draft}
        generationFailed={draftState.generationFailed}
        regenerationsLeft={draftState.regenerationsLeft}
        googleReviewUrl={googleReviewUrl}
        onRegenerate={handleRegenerate}
        // 下書き画面の押下は sessionToken を載せる（Issue #137）。/api/responses の後にしか発行されない
        // ので「実際の回答の後の押下」を証明できる。再生成で進んだ最新の token を使う。
        // 通知は最初の押下だけ（Issue #401）。再生成の後に押し直しても、2 回目は送らない。
        onReviewLinkOpen={() => notifyReviewLinkOnce(draftState.sessionToken)}
        regenerating={regenerating}
      />
      </>
    );
  }

  return (
    <>
      {error !== null && (
        // 読み上げ役割（進行中の読み上げを中断するライブリージョン）は変種から部品が決める。
        // 面の側で役割を手書きすると、部品の分岐と二重管理になる。
        // 下の余白だけは面の側に残す。フォームとの間隔は外側の律であって、通知の部品の領分では
        // ないためである（正典 7.10 が面の側に禁じたのは高さ・内側余白・文字寸法）。
        <Alert className="mb-4" variant="destructive" role={undefined}>
          <AlertDescription>
            {error}
            {stale ? (
              // 古い画面の選択は送り直せない（現在の内容で読み直す）。押しボタンは再読み込みだけをする。
              <button className="mt-2 block underline" type="button" onClick={() => window.location.reload()}>
                ページを再読み込みする
              </button>
            ) : null}
          </AlertDescription>
        </Alert>
      )}
      {survey.mode === 'structured' ? (
        <StructuredSurveyForm definition={survey.definition} onSubmit={handleSubmit} submitting={submitting} />
      ) : (
        <SurveyForm aspects={survey.aspects} onSubmit={handleSubmit} submitting={submitting} />
      )}
    </>
  );
}

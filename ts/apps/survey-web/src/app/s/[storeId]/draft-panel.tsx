'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { toast } from '@fwlm/ui/components/app-toaster';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button, buttonVariants } from '@fwlm/ui/components/button';
import { cn } from '@fwlm/ui/lib/utils';
import { Spinner } from '@fwlm/ui/components/spinner';
import { Textarea } from '@fwlm/ui/components/textarea';
import type { DraftPanelProps } from './types';

// 下書きパネル（葉コンポーネント）。生成中表示・編集・再生成トリガー・コピー・投稿導線を担う。
// API 呼出・状態オーケストレーションはシェル(4.3)が所有し、本体は props 契約に従う。
// コピーは iOS Safari のため「表示済みテキストをジェスチャー内で同期 writeText」する。

type CopyState = 'idle' | 'copied' | 'manual';

export function DraftPanel({
  draft,
  generationFailed,
  regenerationsLeft,
  googleReviewUrl,
  onRegenerate,
  onReviewLinkOpen,
  regenerating,
}: DraftPanelProps) {
  const [text, setText] = useState(draft);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [copying, setCopying] = useState(false);
  const copyingRef = useRef(false);
  const [slow, setSlow] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const noteId = useId();

  // 再生成で新しい下書きが届いたら編集内容を更新する（再生成は上書き）。
  useEffect(() => {
    setText(draft);
    setCopyState('idle');
  }, [draft]);

  useEffect(() => {
    if (!regenerating && !copying) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [regenerating, copying]);

  function finishCopy(): void {
    copyingRef.current = false;
    setCopying(false);
  }

  function handleCopy(): void {
    if (copyingRef.current || regenerating) return;
    copyingRef.current = true;
    setCopying(true);
    setCopyState('idle');
    try {
      // await を挟まずジェスチャー内で同期的に writeText を呼ぶ（Safari 制約）。
      const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        showManualFallback();
        finishCopy();
        return;
      }
      clipboard.writeText(text).then(
        () => {
          setCopyState('copied');
          toast.success('コピーしました。投稿画面に貼り付けてください。');
        },
        () => showManualFallback(),
      ).finally(finishCopy);
    } catch {
      showManualFallback();
      finishCopy();
    }
  }

  function showManualFallback(): void {
    setCopyState('manual');
    toast.error('自動コピーできませんでした。文章を選択して手動でコピーしてください。');
    const el = textareaRef.current;
    if (el) { el.focus(); el.select(); }
  }

  // 投稿導線（全状態・全評価で同一。ゲーティングをしない）。
  // 要素はリンクのまま、見た目だけを押しボタンの部品から借りる（正典 7.9 / 7.10）。
  // 部品そのものを使わないのは、押しボタンとして描くと支援技術に押しボタンとして読まれ、
  // 遷移であることが伝わらなくなるためである。寸法の実値はここに書かない。
  //
  // 押下はシェルへ知らせるだけで、遷移は止めない（Issue #137・Requirement 5.8）。
  const reviewLink = (
    <a
      className={cn(buttonVariants({ variant: 'outline', size: 'lg', className: 'w-full' }))}
      href={googleReviewUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => onReviewLinkOpen()}
    >
      Google のクチコミを書く
    </a>
  );

  const canRegenerate = regenerationsLeft > 0 && !regenerating && !copying;

  // 再生成の押しボタンの中身。生成中は押しボタン自身が処理中であることを示す（押せたかどうかを迷わせない）。
  // 図形は装飾として読み上げから隠し、状態は直下の文言で伝える（動きを止める設定でも読める）。
  function regenerateLabel(idle: string): ReactNode {
    if (!regenerating) return idle;
    return (
      <>
        {/* 部品の読み上げ名（動き低減時に可視化される「読み込み中」）は空にする。状態は直下の文言が伝えるので、
            押しボタンの中で文言を二重に出さない（狭い画面で折り返さない押しボタンからはみ出す）。 */}
        <Spinner aria-hidden aria-label="" />
        別の文章を作成しています…
      </>
    );
  }

  // 処理中の通知は常時マウントする。結果は Toast が読み上げ、画面内の案内は静的に残す。
  const notification = (
    <>
      <div role="status">
        {regenerating || copying ? <p className="text-center text-sm text-muted-foreground">
          {slow ? '少し時間がかかっています。画面を閉じずにこのままお待ちください' : copying ? '文章をコピーしています' : '回答内容をもとに文章を作成しています'}
        </p> : null}
      </div>
      {regenerating || copying ? null : copyState === 'copied' ? (
        <Alert variant="success" role={undefined}>
          <AlertDescription>コピーしました。投稿画面に貼り付けてください。</AlertDescription>
        </Alert>
      ) : copyState === 'manual' ? (
        <Alert role={undefined}>
          <AlertDescription>自動コピーできませんでした。上の文章を選択して手動でコピーしてください。</AlertDescription>
        </Alert>
      ) : null}
    </>
  );

  if (generationFailed) {
    return (
      <section className="space-y-4">
        {/* 読み上げ役割（進行中の読み上げを中断するライブリージョン）は変種から部品が決める。
            面の側で役割を手書きすると、部品の分岐と二重管理になる。 */}
        <Alert variant="destructive" role={undefined}>
          <AlertDescription>
            下書きの生成に失敗しました。再試行するか、そのまま投稿画面へお進みください。
          </AlertDescription>
        </Alert>
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          type="button"
          onClick={() => onRegenerate()}
          disabled={!canRegenerate}
          aria-busy={regenerating}
        >
          {regenerateLabel('もう一度生成する')}
        </Button>
        {notification}
        {reviewLink}
      </section>
    );
  }

  return (
    <section className="space-y-4">
      {/* 下書きの由来と、投稿前に自分の言葉へ直すことの促し（Issue #179）。

          **「AI」の語は出さない。** Google の 2026-04 改定（「評価の操作」の新設）を一次情報で
          確認したところ、日英いずれの原文にも AI・自動生成への言及は無い。禁止の実体は
          「実体験に基づいていないコンテンツ」であり、それを担保する主体はシステムではなく
          客本人である。伝えるべきは生成技術の名前ではなく、素材が客自身の回答であることと、
          投稿するのは客自身の言葉であることの 2 つになる。

          **読み上げ領域の中へ置いてはならない。** 直下の `notification` は差し替え型の
          ライブリージョンで、言うことが無いときも空のまま常時マウントされる。ここへ静的な
          説明を入れると、生成中・コピー結果を通知するたびに説明ごと読み上げ直される。
          同じ理由で通知の部品（Alert）も使わない。変種ごとに読み上げ役割を自分で付けるため、
          この面の穏やかな読み上げ領域が 2 つになる（test/draft-panel.test.tsx の
          `theLiveRegion()` が 1 つであることを固定している）。

          入力欄からは `aria-describedby` で指す。読み上げ名（`aria-label`）は変えない。 */}
      <p id={noteId} className="text-sm text-muted-foreground">
        あなたの回答をもとに作成した下書きです。ご自身の言葉に直してから投稿してください。
      </p>
      {/* 生成された下書きは全文が一目で読める高さを確保する。
          高さを実際に担っているのは **面の側の最小高さ** である。行数の指定は、部品が内容に
          応じて高さを決める指定を自分で持つため、対応するブラウザでは効かない（対応していない
          ブラウザ向けの控えとして残す）。したがって行数だけを固定しても高さは守られない。
          輪郭・内側余白・文字寸法は部品の領分なので面の側では指定しない。 */}
      <Textarea
        className="min-h-64 leading-relaxed"
        rows={10}
        ref={textareaRef}
        aria-label="口コミ下書き"
        aria-describedby={noteId}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setCopyState('idle');
        }}
      />
      <div className="flex flex-col gap-3">
        {/* 客向け面の主操作は拡大の区分で全幅（正典 7.9 / 7.10）。寸法の実値は部品の側が持つ。 */}
        <Button size="lg" className="w-full" type="button" onClick={handleCopy} disabled={copying || regenerating} aria-busy={copying}>
          {copying ? <><Spinner aria-hidden aria-label="" />コピー中…</> : 'コピーして投稿する'}
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          type="button"
          onClick={() => onRegenerate()}
          disabled={!canRegenerate}
          aria-busy={regenerating}
        >
          {regenerateLabel(`別の文章を生成（残り${regenerationsLeft}回）`)}
        </Button>
      </div>
      {notification}
      {reviewLink}
    </section>
  );
}

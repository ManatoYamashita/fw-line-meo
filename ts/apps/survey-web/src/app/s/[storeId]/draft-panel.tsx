'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { toast } from '@fwlm/ui/components/app-toaster';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button, buttonVariants } from '@fwlm/ui/components/button';
import { cn } from '@fwlm/ui/lib/utils';
import { Spinner } from '@fwlm/ui/components/spinner';
import { Textarea } from '@fwlm/ui/components/textarea';
import { liftNeeded, settledToastTop } from '../../../lib/toast-clearance';
import type { DraftPanelProps } from './types';

// 下書きパネル（葉コンポーネント）。生成中表示・編集・再生成トリガー・コピー・投稿導線を担う。
// API 呼出・状態オーケストレーションはシェル(4.3)が所有し、本体は props 契約に従う。
// コピーは iOS Safari のため「表示済みテキストをジェスチャー内で同期 writeText」する。

type CopyState = 'idle' | 'copied' | 'manual';

// 投稿導線の文言。コピーの案内がリンクを名前で指すので、1 箇所で持つ。
const REVIEW_LINK_LABEL = 'Google のクチコミ欄を開く';
// コピー成功後の案内（Toast と画面内の通知で同じ文言）。コピーだけでは投稿画面は開かないので、
// 次に押すリンクを名前で指す（Requirement 4.1・4.2）。
// コピーに失敗したときに、入力欄の上端を画面の上端から残す幅（px）。
const TEXTAREA_KEEP_TOP = 8;
const COPIED_MESSAGE = `コピーしました。「${REVIEW_LINK_LABEL}」から投稿画面を開き、本文欄に貼り付けてください。`;

export function DraftPanel({
  draft,
  draftRevision,
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
  const actionsRef = useRef<HTMLDivElement>(null);
  // 操作の並びを Toast より上へ送るために、パネルの下に足す余白（px）。送り先の余地が足りない
  // ときに、足りない分だけ足す。コピーの Toast が閉じたら、画面を動かさずに外せる分を外す
  // （PR #470・lib/toast-clearance.ts）。
  const [toastRoom, setToastRoom] = useState(0);
  const [pendingLift, setPendingLift] = useState(0);
  const roomTriesRef = useRef(0);
  // 表示中のコピーの結果の Toast。次のコピーでは前のものを閉じてから出す（積み重ねて操作を
  // 押し上げ続けない）。
  const copyToastRef = useRef<string | number | null>(null);
  const noteId = useId();

  // 再生成で新しい下書きが届いたら編集内容を更新する（再生成は上書き）。同じ文面が届いた成功も
  // draftRevision で見分ける。失敗ではシェルが draft・draftRevision とも据え置くので、編集内容は残る。
  useEffect(() => {
    setText(draft);
    setCopyState('idle');
    setToastRoom(0);
  }, [draft, draftRevision]);

  // 送り先の余地を確かめてから画面を送る。足りなければ足りない分だけ余白を足し、描かれた後で
  // もう一度確かめる（面の最小の高さに空きがあると、足した余白がそのまま余地にならないため）。
  useEffect(() => {
    if (pendingLift <= 0) return;
    const root = document.documentElement;
    const deficit = Math.ceil(window.scrollY + pendingLift - (root.scrollHeight - window.innerHeight));
    if (deficit > 0 && roomTriesRef.current < 3) {
      roomTriesRef.current += 1;
      setToastRoom((room) => room + deficit);
      return;
    }
    roomTriesRef.current = 0;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollBy({ top: pendingLift, behavior: reduce ? 'auto' : 'smooth' });
    setPendingLift(0);
  }, [pendingLift, toastRoom]);

  useEffect(() => {
    if (!regenerating && !copying) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [regenerating, copying]);

  // コピーの結果の Toast が、次に押す「Google のクチコミ欄を開く」と再生成を覆わないようにする。
  // Toast の置き場（右下・design-language 7.5）と表示時間は共通の Toaster のまま変えず、
  // 覆われる位置にあるときだけ、操作の並びが Toast の上に来るよう画面を送る。
  // Toast は通知の呼び出しの後に描かれるので、描かれるまで数フレーム待ってから測る。
  //
  // コピーに失敗したときの主な操作は、選択済みの文章を手動でコピーすることである。そのため
  // 失敗時は、入力欄の上端が画面に残る範囲でしか送らない（文字を拡大した画面などで、入力欄が
  // 画面の上へ消えるのを防ぐ）。その範囲で送り切れなければ、Toast が消えるまでリンクが
  // 覆われることを許す（手動でコピーした後に押す操作なので、急がない）。
  function keepActionsAboveToasts(outcome: 'copied' | 'manual'): void {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
    let frames = 0;
    const measure = (): void => {
      const toastTop = settledToastTop(document);
      // Toast が描かれ、Sonner が積み重ねの量を書き終えるまで待つ（描かれた次のフレームで測る）。
      if (toastTop === null && frames < 30) { frames += 1; window.requestAnimationFrame(measure); return; }
      if (frames < 2) { frames += 1; window.requestAnimationFrame(measure); return; }
      const actions = actionsRef.current;
      if (!actions) return;
      let lift = liftNeeded(actions.getBoundingClientRect().bottom, toastTop);
      if (outcome === 'manual' && textareaRef.current) {
        lift = Math.min(lift, Math.max(0, Math.floor(textareaRef.current.getBoundingClientRect().top) - TEXTAREA_KEEP_TOP));
      }
      if (lift <= 0) return;
      setPendingLift(lift);
    };
    window.requestAnimationFrame(measure);
  }

  // コピーの結果の Toast を出す。前の結果の Toast は閉じる。閉じたら余白を戻す。
  function showCopyToast(kind: 'success' | 'error', message: string): void {
    if (copyToastRef.current !== null) toast.dismiss(copyToastRef.current);
    const release = (closed: { id: string | number }): void => {
      if (closed.id !== copyToastRef.current) return;
      copyToastRef.current = null;
      releaseToastRoom();
    };
    copyToastRef.current = toast[kind](message, { onAutoClose: release, onDismiss: release }) ?? null;
  }

  // 余白のうち、画面を動かさずに外せる分（いま見えている位置より下の余地）だけを外す。
  // 全部を外すと、送った位置にいる客の画面が跳ねて、押そうとしていた操作が動いてしまう。
  function releaseToastRoom(): void {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    const slack = Math.max(0, Math.floor(root.scrollHeight - window.innerHeight - window.scrollY));
    setToastRoom((room) => Math.max(0, room - slack));
  }

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
          showCopyToast('success', COPIED_MESSAGE);
          keepActionsAboveToasts('copied');
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
    showCopyToast('error', '自動コピーできませんでした。文章を選択して手動でコピーしてください。');
    const el = textareaRef.current;
    if (el) { el.focus(); el.select(); }
    keepActionsAboveToasts('manual');
  }

  // 投稿導線（全状態・全評価で同一。ゲーティングをしない）。
  // 要素はリンクのまま、見た目だけを押しボタンの部品から借りる（正典 7.9 / 7.10）。
  // 部品そのものを使わないのは、押しボタンとして描くと支援技術に押しボタンとして読まれ、
  // 遷移であることが伝わらなくなるためである。寸法の実値はここに書かない。
  //
  // 押下はシェルへ知らせるだけで、遷移は止めない（Issue #137・Requirement 5.8）。
  //
  // コピーとは別の押下にする（Requirement 4.1 の解釈）。コピーの後に自動で開く形は採らない:
  // LINE 内ブラウザで別タブを開いたときの挙動が一次情報で確かめられず、遷移した後にコピーの失敗が
  // 分かっても戻って復旧できず、コピーの完了を待ってから開く遷移はジェスチャーの外になるためである。
  // コピーの成否でも出し分けない（失敗しても手動でコピーしたあとに開ける）。
  const reviewLink = (
    <a
      className={cn(buttonVariants({ variant: 'outline', size: 'lg', className: 'w-full' }))}
      href={googleReviewUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => onReviewLinkOpen()}
    >
      {REVIEW_LINK_LABEL}
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
          <AlertDescription>{COPIED_MESSAGE}</AlertDescription>
        </Alert>
      ) : copyState === 'manual' ? (
        <Alert role={undefined}>
          <AlertDescription>
            {`自動コピーできませんでした。上の文章を選択して手動でコピーしたあと、「${REVIEW_LINK_LABEL}」から投稿画面を開けます。`}
          </AlertDescription>
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
      <div ref={actionsRef} className="flex flex-col gap-3">
        {/* 客向け面の主操作は拡大の区分で全幅（正典 7.9 / 7.10）。寸法の実値は部品の側が持つ。
            コピー → 投稿画面を開く、の順に客が押す 2 つの操作を並べる（Requirement 4.1）。
            主ボタンはコピーしかしないので「投稿する」と名乗らない。再生成はその後ろに置く。 */}
        <Button size="lg" className="w-full" type="button" onClick={handleCopy} disabled={copying || regenerating} aria-busy={copying}>
          {copying ? <><Spinner aria-hidden aria-label="" />コピー中…</> : '文章をコピー'}
        </Button>
        {reviewLink}
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
      {/* Toast の上へ操作を送るための余地（keepActionsAboveToasts）。装飾なので読み上げない。 */}
      {toastRoom > 0 ? <div aria-hidden="true" data-slot="toast-room" style={{ height: toastRoom }} /> : null}
    </section>
  );
}

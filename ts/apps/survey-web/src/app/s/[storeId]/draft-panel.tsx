'use client';

import { useEffect, useRef, useState } from 'react';
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
  regenerating,
}: DraftPanelProps) {
  const [text, setText] = useState(draft);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 再生成で新しい下書きが届いたら編集内容を更新する（再生成は上書き）。
  useEffect(() => {
    setText(draft);
    setCopyState('idle');
  }, [draft]);

  function handleCopy(): void {
    // await を挟まずジェスチャー内で同期的に writeText を呼ぶ（Safari 制約）。
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      showManualFallback();
      return;
    }
    clipboard.writeText(text).then(
      () => setCopyState('copied'),
      () => showManualFallback(),
    );
  }

  function showManualFallback(): void {
    setCopyState('manual');
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }

  // 投稿導線（全状態・全評価で同一。ゲーティングをしない）。
  // 要素はリンクのまま、見た目だけを押しボタンの部品から借りる（正典 7.9 / 7.10）。
  // 部品そのものを使わないのは、押しボタンとして描くと支援技術に押しボタンとして読まれ、
  // 遷移であることが伝わらなくなるためである。寸法の実値はここに書かない。
  const reviewLink = (
    <a
      className={cn(buttonVariants({ variant: 'outline', size: 'lg', className: 'w-full' }))}
      href={googleReviewUrl}
      target="_blank"
      rel="noopener noreferrer"
    >
      Google のクチコミを書く
    </a>
  );

  const canRegenerate = regenerationsLeft > 0 && !regenerating;

  // 穏やかな通知（生成中・コピー結果）を **1 つのライブリージョンへ集約する**。
  //
  // 領域を内容と同時に DOM へ挿入する形（`{regenerating && <p aria-live="polite">…</p>}`）では、
  // 支援技術は挿入を「領域の出現」として扱い、読み上げが発火しない。容器を常時マウントし、
  // 中身だけを差し替える。したがって言うことが無いときは容器だけが空で残る。
  //
  // 読み上げ強度は穏やか（`status`）で固定する。進行中の読み上げを中断させる強度は生成失敗の
  // 通知だけの権利であり、処理中やコピー結果でそれを使うと利用者の作業が毎回遮られる。
  //
  // **容器そのものを通知の部品にはできない。** 通知の部品は言うことが無いときも枠と内側余白を
  // 描くため、空のまま常時マウントすると中身の無い箱が見えたままになる。容器は素の要素にし、
  // 通知の部品はその中身として使う（部品の割り当ては design.md「Error Handling」が正典）。
  //
  // **中身の通知からは役割を外す（`role={undefined}`）。** 通知の部品は変種ごとに読み上げ役割を
  // 自分で付けるため、そのままだと容器と合わせて穏やかな読み上げ領域が 2 つになる。役割は容器が
  // 1 つだけ持ち、部品には見た目と変種だけを担わせる。部品は `role` を `{...props}` より前に
  // 置いており、呼び出し側からの上書きを想定した作りである。
  //
  // 集約はもう 1 つの欠陥も直す。`copyState` は `draft` が変わるまで idle へ戻らないため、
  // 領域を分けているとコピー後に再生成を押した時点で「生成中…」と「コピーしました…」の
  // 2 つが同時に読み上げ対象として並んでいた。
  const notification = (
    <div role="status">
      {regenerating ? (
        // 文言は直下のテキストノードのまま残す。処理中の図形へ読み上げ名として畳むと、文言が
        // 部品内部の読み上げ専用要素へ移り、動きの低減が要求されていない実ブラウザでは見えなく
        // なる。図形は装飾なので必ず読み上げから隠す。
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden />
          生成中…
        </p>
      ) : copyState === 'copied' ? (
        <Alert variant="success" role={undefined}>
          <AlertDescription>コピーしました。投稿画面に貼り付けてください。</AlertDescription>
        </Alert>
      ) : copyState === 'manual' ? (
        // 自動コピーが働かなかったことは失敗ではなく次の手順の案内なので、既定の変種で描く。
        <Alert role={undefined}>
          <AlertDescription>
            自動コピーできませんでした。上の文章を選択して手動でコピーしてください。
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );

  if (generationFailed) {
    return (
      <section className="space-y-4">
        {/* 読み上げ役割（進行中の読み上げを中断するライブリージョン）は変種から部品が決める。
            面の側で役割を手書きすると、部品の分岐と二重管理になる。 */}
        <Alert variant="destructive">
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
        >
          もう一度生成する
        </Button>
        {notification}
        {reviewLink}
      </section>
    );
  }

  return (
    <section className="space-y-4">
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
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setCopyState('idle');
        }}
      />
      <div className="flex flex-col gap-3">
        {/* 客向け面の主操作は拡大の区分で全幅（正典 7.9 / 7.10）。寸法の実値は部品の側が持つ。 */}
        <Button size="lg" className="w-full" type="button" onClick={handleCopy}>
          コピーして投稿する
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          type="button"
          onClick={() => onRegenerate()}
          disabled={!canRegenerate}
        >
          別の文章を生成（残り{regenerationsLeft}回）
        </Button>
      </div>
      {notification}
      {reviewLink}
    </section>
  );
}

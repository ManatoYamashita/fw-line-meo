'use client';

import { useEffect, useRef, useState } from 'react';
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
  const reviewLink = (
    <a href={googleReviewUrl} target="_blank" rel="noopener noreferrer">
      Google のクチコミを書く
    </a>
  );

  const canRegenerate = regenerationsLeft > 0 && !regenerating;

  if (generationFailed) {
    return (
      <section>
        {regenerating && <p aria-live="polite">生成中…</p>}
        <p role="alert">下書きの生成に失敗しました。再試行するか、そのまま投稿画面へお進みください。</p>
        <button type="button" onClick={() => onRegenerate()} disabled={!canRegenerate}>
          もう一度生成する
        </button>
        {reviewLink}
      </section>
    );
  }

  return (
    <section>
      {regenerating && <p aria-live="polite">生成中…</p>}
      <textarea
        ref={textareaRef}
        aria-label="口コミ下書き"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setCopyState('idle');
        }}
      />
      <div>
        <button type="button" onClick={handleCopy}>
          コピーして投稿する
        </button>
        <button type="button" onClick={() => onRegenerate()} disabled={!canRegenerate}>
          別の文章を生成（残り{regenerationsLeft}回）
        </button>
      </div>
      {copyState === 'copied' && <p role="status">コピーしました。投稿画面に貼り付けてください。</p>}
      {copyState === 'manual' && (
        <p role="status">自動コピーできませんでした。上の文章を選択して手動でコピーしてください。</p>
      )}
      {reviewLink}
    </section>
  );
}

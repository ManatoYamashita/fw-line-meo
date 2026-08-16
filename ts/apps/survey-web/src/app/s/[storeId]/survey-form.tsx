'use client';

import { useState } from 'react';
import { Button } from '@fwlm/ui/components/button';
import type { SurveyAnswer, SurveyFormProps } from './types';

// 回答フォーム（葉コンポーネント）。星評価（必須）・良かった点（複数選択）・一言（任意 200 字）を
// タップ中心で入力し、星未入力時は送信を止めて必須を明示、onSubmit で親シェルへ回答を渡す。
// API 呼出はシェル(4.3)が所有し、本コンポーネントは入力と即時のクライアント検証のみ。

const COMMENT_MAX = 200;
const STARS = [1, 2, 3, 4, 5] as const;

export function SurveyForm({ aspects, onSubmit, submitting }: SurveyFormProps) {
  const [star, setStar] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [comment, setComment] = useState('');
  const [showStarError, setShowStarError] = useState(false);

  function toggleAspect(code: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function submit(): void {
    if (star === null) {
      setShowStarError(true);
      return;
    }
    const aspectCodes = [...selected];
    const answer: SurveyAnswer =
      comment.trim() !== '' ? { star, aspectCodes, comment } : { star, aspectCodes };
    onSubmit(answer);
  }

  return (
    <form
      className="space-y-8"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset className="space-y-2">
        <legend className="mb-2 text-lg font-semibold">満足度（必須）</legend>
        {STARS.map((n) => (
          <button
            className={`min-h-11 min-w-11 px-1 text-4xl leading-none ${
              star !== null && n <= star ? 'text-primary' : 'text-muted-foreground'
            }`}
            type="button"
            key={n}
            aria-label={`星${n}`}
            aria-pressed={star === n}
            onClick={() => {
              setStar(n);
              setShowStarError(false);
            }}
          >
            {star !== null && n <= star ? '★' : '☆'}
          </button>
        ))}
        {showStarError && (
          <p className="text-sm font-medium text-destructive" role="alert">
            満足度を選択してください
          </p>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-lg font-semibold">良かった点</legend>
        {aspects.map((a) => (
          // 折り返しは inline-flex + 余白で行い、包む要素を足さない（DOM 構造は据え置き）。
          <label
            className={`mr-2 mb-2 inline-flex min-h-11 items-center gap-2 rounded-lg border px-4 py-2 ${
              selected.has(a.code) ? 'border-primary bg-secondary' : 'border-input'
            }`}
            key={a.code}
          >
            <input
              type="checkbox"
              checked={selected.has(a.code)}
              onChange={() => toggleAspect(a.code)}
            />
            {a.label}
          </label>
        ))}
      </fieldset>

      <label className="block text-lg font-semibold">
        一言（任意）
        <textarea
          className="mt-2 block w-full rounded-lg border border-input p-3 text-base font-normal"
          rows={3}
          value={comment}
          maxLength={COMMENT_MAX}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>

      <Button className="min-h-11 w-full px-6 py-3 text-lg font-semibold" type="submit" disabled={submitting}>
        送信する
      </Button>
    </form>
  );
}

'use client';

import { useState } from 'react';
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
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset>
        <legend>満足度（必須）</legend>
        {STARS.map((n) => (
          <button
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
        {showStarError && <p role="alert">満足度を選択してください</p>}
      </fieldset>

      <fieldset>
        <legend>良かった点</legend>
        {aspects.map((a) => (
          <label key={a.code}>
            <input
              type="checkbox"
              checked={selected.has(a.code)}
              onChange={() => toggleAspect(a.code)}
            />
            {a.label}
          </label>
        ))}
      </fieldset>

      <label>
        一言（任意）
        <textarea
          value={comment}
          maxLength={COMMENT_MAX}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>

      <button type="submit" disabled={submitting}>
        送信する
      </button>
    </form>
  );
}

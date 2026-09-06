'use client';

import { useState } from 'react';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { Checkbox } from '@fwlm/ui/components/checkbox';
import { Textarea } from '@fwlm/ui/components/textarea';
import type { SurveyAnswer, SurveyFormProps } from './types';

// 回答フォーム（葉コンポーネント）。星評価（必須）・良かった点（複数選択）・一言（任意 200 字）を
// タップ中心で入力し、星未入力時は送信を止めて必須を明示、onSubmit で親シェルへ回答を渡す。
// API 呼出はシェル(4.3)が所有し、本コンポーネントは入力と即時のクライアント検証のみ。

const COMMENT_MAX = 200;
const STARS = [1, 2, 3, 4, 5] as const;

// 一言欄の記入例（Issue #137 段階1）。素材が薄い回答ほど AI 下書きの事実性が崩れることを
// Issue #132 で実測しており（具体的な一言がある素材は逸脱 0/20）、材料を増やす方が是正を層として
// 積むより構造的に効く。ただし摩擦は増やさない。任意のままとし、選択肢も必須条件も変えない
// （Requirement 2.3: 星評価のみ必須）。
//
// 例の選び方には 2 つの制約がある。
//   - 観点を 2 つに分散させる（味系と提供/接客系）。片方だけを挙げると、その観点に寄った
//     一言ばかりが集まり、下書きの材料としても集計の分布としても偏る。
//   - 肯定と否定を 1 つずつにする。良かったことの例しか出さないと、低評価の客が書きにくく
//     なる。これは導線を分岐させていなくても実質的にレビューゲーティングへ近づく作用を持つ。
const COMMENT_PLACEHOLDER = '例）料理が熱々だった／提供まで少し待った';

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
            className={`min-h-11 min-w-11 px-1 text-4xl leading-none transition-colors duration-150 ${
              star !== null && n <= star ? 'text-foreground' : 'text-muted-foreground'
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
          // 読み上げ役割（進行中の読み上げを中断するライブリージョン）は変種から部品が決める。
          // 面の側で役割を手書きすると、部品の分岐と二重管理になる。
          <Alert variant="destructive">
            <AlertDescription>満足度を選択してください</AlertDescription>
          </Alert>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-lg font-semibold">良かった点</legend>
        {aspects.map((a) => (
          // 折り返しは inline-flex + 余白で行う。枠の色は選択状態によらず一定にし、選択済みで
          // あることは選択部品自身の塗りとチェック印が担う。枠にも状態を持たせると、同じ状態が
          // 面内で 2 通りに描かれ、片方だけが意匠の変更に取り残される。
          //
          // 読み上げ名は可視の文言そのものを指す。選択部品へ読み上げ名を直接書くと、同じ文言を
          // 2 箇所で管理することになり、片方だけが古びても誰も気づけない。
          //
          // **明示する理由。** 指定を外しても名前自体は解決される。基盤ライブラリは
          // `<span role="checkbox">` として描かれるため包む `<label>` からの補完が働き、
          // そのとき **`<label>` 要素へ生成 id を書き込む**（実測: `base-ui-_r_2_` が付いた）。
          // 名前の出所がライブラリの実行時判断になり、面の側の印字からは読めなくなる。
          // ここで指す先を固定すると、出所が可視の文言そのものに定まる。
          <label
            className="mr-2 mb-2 inline-flex min-h-11 items-center gap-2 rounded-lg border border-input px-4 py-2 transition-colors duration-150"
            key={a.code}
          >
            <Checkbox
              checked={selected.has(a.code)}
              onCheckedChange={() => toggleAspect(a.code)}
              aria-labelledby={`aspect-label-${a.code}`}
            />
            <span id={`aspect-label-${a.code}`}>{a.label}</span>
          </label>
        ))}
      </fieldset>

      {/*
        見出し相当の文字寸法はラベルの文言そのものへ与える。ラベル領域に与えると複数行入力へ
        継承され、それを面の側で打ち消す指定が要る（＝部品が持つ文字寸法を面が書き換える形になる）。
      */}
      <label className="block">
        <span className="text-lg font-semibold">一言（任意）</span>
        <Textarea
          className="mt-2"
          rows={3}
          value={comment}
          maxLength={COMMENT_MAX}
          placeholder={COMMENT_PLACEHOLDER}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>

      {/* 客向け面の主操作は拡大の区分で全幅（正典 7.9 / 7.10）。寸法の実値は部品の側が持つ。 */}
      <Button size="lg" className="w-full" type="submit" disabled={submitting}>
        送信する
      </Button>
    </form>
  );
}

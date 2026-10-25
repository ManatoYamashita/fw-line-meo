'use client';

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { Star } from '../../../lib/domain';

// 満足度の星（Issue #492）。React Bits の Peek Rating（https://reactbits.dev/c/micro/peek-rating・
// MIT + Commons Clause）を移植し、この面の規律に合わせて次を改めた。
//   - 依存を足さない。原作の @hugeicons/* の代わりに星を inline SVG で描く。
//   - 色はデザイントークンだけを使う。選択済みはブランド色で塗り、アクション色で縁取る。ブランド色は
//     白背景に対して 3:1 に届かないため、状態を示す図形の境界（WCAG 1.4.11）は縁が担う。
//     未選択は塗らずに補足色の縁だけを描き、塗りの有無という形の差でも状態を伝える（色だけに頼らない）。
//   - 星は必須なので取り消し（同じ星をもう一度押すと 0 に戻る）を持たない。
//   - 原作は pointerup とキーボードでしか確定しない。支援技術の仮想クリック（pointer を伴わない click）
//     でも確定させるため、各 radio に click の受け口を置く。
//   - 動き低減の打ち消しをクラスで書かない（正典 docs/design/design-language.md §7.11）。色の遷移は
//     theme.css の base 層が一括で抑える。持ち上がりと確定時のポップは inline の transform と
//     Web Animations で描くため CSS の抑制が届かず、JS で prefers-reduced-motion を見て止める。

/** 星ごとの言葉。吹き出しと読み上げ名に使う。並びは星 1〜5。 */
export const STAR_LABELS = ['不満', 'やや不満', 'ふつう', '満足', 'とても満足'] as const;

const STARS: readonly Star[] = [1, 2, 3, 4, 5];
const COUNT = STARS.length;

/** 持ち上がりの高さ（px）・指の下の星の拡大率・持ち上がりの所要時間（ms）・確定時のポップの拡大率。 */
const LIFT = 6;
const MAGNIFY = 1.15;
const POP_SCALE = 1.3;
const POP_MS = 300;
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

export function starName(star: Star): string {
  return `星${star}：${STAR_LABELS[star - 1]}`;
}

interface GestureState {
  hover: number | null;
  pressing: boolean;
  pointerId: number | null;
  settled: boolean;
  rect: DOMRect | null;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export interface StarRatingProps {
  value: Star | null;
  onChange: (value: Star) => void;
  /** 群の名前を与える見出し（fieldset の legend）の id。 */
  labelledBy: string;
  /** 必須エラーの案内の id。出ていないときは渡さない。 */
  describedBy?: string;
}

export function StarRating({ value, onChange, labelledBy, describedBy }: StarRatingProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const tipEl = useRef<HTMLSpanElement>(null);
  const starEls = useRef<(HTMLButtonElement | null)[]>([]);
  const liftEls = useRef<(HTMLSpanElement | null)[]>([]);
  const glyphEls = useRef<(SVGSVGElement | null)[]>([]);
  const st = useRef<GestureState>({ hover: null, pressing: false, pointerId: null, settled: false, rect: null });
  const shownValue = value ?? 0;

  // 指で選んでいる途中の見た目（持ち上がり・プレビューの塗り・吹き出し）は DOM へ直接書く。
  // 動かすたびに再描画すると、なぞる速さに描画が追いつかないため（原作の設計）。
  const paint = () => {
    const { hover, settled } = st.current;
    const previewing = hover !== null && !settled;
    const shown = previewing ? hover + 1 : shownValue;
    const still = reducedMotion();

    for (let i = 0; i < COUNT; i++) {
      const liftEl = liftEls.current[i];
      const glyphEl = glyphEls.current[i];
      if (!liftEl || !glyphEl) continue;
      const lifted = previewing && !still && i <= hover;
      liftEl.style.transform = lifted
        ? `translateY(${-LIFT}px) scale(${i === hover ? MAGNIFY : 1})`
        : 'translateY(0px) scale(1)';
      glyphEl.dataset.lit = String(i < shown);
    }

    const tip = tipEl.current;
    const row = rowRef.current;
    if (!tip || !row) return;
    if (previewing) {
      const slot = row.clientWidth / COUNT;
      const wasHidden = tip.dataset.show !== 'true';
      // 出始めは位置を飛ばす。隠れていた位置から滑ってくると、別の星の言葉に見えるため。
      if (wasHidden) tip.style.transition = 'none';
      tip.textContent = STAR_LABELS[hover] ?? '';
      tip.style.transform = `translate(calc(${slot * (hover + 0.5)}px - 50%), 0)`;
      if (wasHidden) {
        void tip.offsetWidth;
        tip.style.transition = '';
      }
      tip.dataset.show = 'true';
    } else {
      tip.dataset.show = 'false';
    }
  };
  useLayoutEffect(paint);

  const setHover = (index: number | null) => {
    if (index === st.current.hover) return;
    st.current.hover = index;
    if (index !== null) st.current.settled = false;
    paint();
  };
  const setHoverRef = useRef(setHover);
  setHoverRef.current = setHover;

  const measure = () => {
    const row = rowRef.current;
    if (row) st.current.rect = row.getBoundingClientRect();
  };

  const indexAt = (x: number, y: number): number | null => {
    const { rect, pressing } = st.current;
    if (!rect || !rect.width) return null;
    // 押したまま星の列から大きく外れたら、確定しない（指を離す場所を選び直せるように）。
    if (pressing && (y < rect.top - rect.height || y > rect.bottom + rect.height)) return null;
    return clamp(Math.floor(((x - rect.left) / rect.width) * COUNT), 0, COUNT - 1);
  };

  const commit = (next: Star, pop: boolean) => {
    onChange(next);
    st.current.settled = true;
    paint();
    const glyph = glyphEls.current[next - 1];
    if (pop && glyph && typeof glyph.animate === 'function' && !reducedMotion()) {
      glyph.getAnimations().forEach((animation) => animation.cancel());
      glyph.animate(
        [
          { transform: 'scale(1)', easing: EASE_OUT },
          { transform: `scale(${POP_SCALE})`, offset: 0.35, easing: EASE_OUT },
          { transform: 'scale(1)' },
        ],
        { duration: POP_MS },
      );
    }
  };

  const handlePointerEnter = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    rootRef.current?.removeAttribute('data-instant');
    measure();
  };

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || st.current.pointerId !== null) return;
    rootRef.current?.removeAttribute('data-instant');
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // swallowed-exception: intentional — 捕捉できない環境でも、列の上で離せば確定できる。
    }
    st.current.pointerId = e.pointerId;
    st.current.pressing = true;
    measure();
    setHover(indexAt(e.clientX, e.clientY));
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const { pressing, pointerId } = st.current;
    if (e.pointerType !== 'mouse' && !pressing) return;
    if (pressing && e.pointerId !== pointerId) return;
    if (!pressing && !st.current.rect) measure();
    setHover(indexAt(e.clientX, e.clientY));
  };

  const endPress = (e: PointerEvent<HTMLDivElement>) => {
    const { pressing, pointerId, hover } = st.current;
    if (!pressing || e.pointerId !== pointerId) return;
    st.current.pressing = false;
    st.current.pointerId = null;
    if (e.type === 'pointerup' && hover !== null) commit(STARS[hover]!, true);
    if (e.pointerType !== 'mouse') setHover(null);
  };

  const handlePointerLeave = () => {
    if (!st.current.pressing) setHover(null);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = clamp(shownValue + 1, 1, COUNT);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = clamp(shownValue - 1, 1, COUNT);
        break;
      case 'Home':
        next = 1;
        break;
      case 'End':
        next = COUNT;
        break;
      case ' ':
      case 'Enter': {
        const index = starEls.current.indexOf(e.target as HTMLButtonElement);
        if (index === -1) return;
        next = index + 1;
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    rootRef.current?.setAttribute('data-instant', 'true');
    st.current.hover = null;
    commit(STARS[next - 1]!, false);
    starEls.current[next - 1]?.focus();
  };

  useEffect(() => {
    const reset = () => {
      st.current.pressing = false;
      st.current.pointerId = null;
      setHoverRef.current(null);
    };
    const onVisibility = () => {
      if (document.hidden) reset();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', reset);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', reset);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-required="true"
      className="group inline-flex"
      onKeyDown={handleKeyDown}
    >
      <div
        ref={rowRef}
        className="relative inline-flex touch-pan-y select-none items-end pt-10 [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none]"
        onPointerEnter={handlePointerEnter}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onLostPointerCapture={endPress}
        onPointerLeave={handlePointerLeave}
      >
        <span
          ref={tipEl}
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 inline-flex h-7 items-center whitespace-nowrap rounded-full bg-foreground px-3 text-sm leading-none font-semibold text-background opacity-0 shadow-raised transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] group-data-[instant=true]:duration-0 data-[show=true]:opacity-100"
        />
        {STARS.map((n, i) => {
          const checked = value === n;
          const lit = n <= shownValue;
          return (
            <button
              key={n}
              ref={(el) => {
                starEls.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={starName(n)}
              tabIndex={(value === null ? i === 0 : checked) ? 0 : -1}
              className="grid size-12 touch-manipulation place-items-center [@media(hover:hover)_and_(pointer:fine)]:cursor-pointer"
              onClick={(e) => {
                // 指やマウスの click（detail >= 1）は pointerup で確定済み。detail が 0 の click は
                // 支援技術の仮想クリックかキーボードによるもので、pointer を伴わないためここで確定する。
                if (e.detail !== 0) return;
                commit(n, false);
              }}
            >
              <span
                ref={(el) => {
                  liftEls.current[i] = el;
                }}
                className="block origin-bottom transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] group-data-[instant=true]:duration-0"
              >
                <svg
                  ref={(el) => {
                    glyphEls.current[i] = el;
                  }}
                  data-lit={String(lit)}
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                  className="block size-9 fill-transparent stroke-muted-foreground transition-colors duration-150 group-data-[instant=true]:duration-0 data-[lit=true]:fill-brand data-[lit=true]:stroke-primary"
                >
                  <polygon
                    points="12 2.5 14.94 8.46 21.5 9.41 16.75 14.04 17.87 20.58 12 17.5 6.13 20.58 7.25 14.04 2.5 9.41 9.06 8.46"
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

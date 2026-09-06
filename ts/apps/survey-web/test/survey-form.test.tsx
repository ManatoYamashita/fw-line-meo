// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { buttonVariants } from '@fwlm/ui/components/button';
import { SurveyForm } from '../src/app/s/[storeId]/survey-form';

// jsdom 25 は PointerEvent を実装していない。一方 Base UI の Checkbox は、キーボード/クリックの
// 活性化を隠し input へ `new PointerEvent('click')` で転送する（CheckboxRoot の onClick）。
// 実ブラウザには必ず存在する API のため、環境差を埋める最小の互換実装を用意する
// （コンポーネントの挙動を書き換えるものではなく、テスト環境の欠落を補うだけ）。
//
// 出典: `ts/packages/ui/test/components.test.tsx` の冒頭にある同じ実装。共有の setup ファイルは
// 存在しないため、Checkbox 部品を通す面のテストはそれぞれ冒頭でこれを持つ。
if (!('PointerEvent' in window)) {
  class PointerEventPolyfill extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', {
    value: PointerEventPolyfill,
    configurable: true,
    writable: true,
  });
}

const ASPECTS = [
  { code: 'taste', label: '味' },
  { code: 'service', label: '接客' },
];

afterEach(cleanup);

function setup(submitting = false) {
  const onSubmit = vi.fn();
  render(<SurveyForm aspects={ASPECTS} onSubmit={onSubmit} submitting={submitting} />);
  return { onSubmit };
}

describe('SurveyForm', () => {
  it('星のみで送信できる（aspectCodes 空）', () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: '星5' }));
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 5, aspectCodes: [] });
  });

  it('星なしでは送信できず必須エラーを表示する', () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('満足度');
  });

  it('星＋良かった点＋一言を送信する', () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: '星4' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '味' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'おいしい' } });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 4, aspectCodes: ['taste'], comment: 'おいしい' });
  });

  it('良かった点は選択・解除できる', () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: '星3' }));
    const taste = screen.getByRole('checkbox', { name: '味' });
    fireEvent.click(taste); // 選択
    fireEvent.click(taste); // 解除
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 3, aspectCodes: [] });
  });

  it('一言は 200 字上限（maxLength 属性）', () => {
    setup();
    const textarea = screen.getByRole('textbox');
    expect(textarea.getAttribute('maxLength')).toBe('200');
  });

  it('一言欄に記入例のプレースホルダーが出る（Issue #137 段階1）', () => {
    setup();
    const textarea = screen.getByRole('textbox');
    // 文言まで固定する。記入例は「観点を 2 つに分散させる」「肯定と否定を 1 つずつ持つ」
    // という 2 つの意図で選んであり、片方へ寄せる変更や黙った削除を落としたい。
    expect(textarea.getAttribute('placeholder')).toBe('例）料理が熱々だった／提供まで少し待った');
    // 記入例を出しても入力必須にはしない（Requirement 2.3・摩擦を増やさない）。
    expect(textarea.hasAttribute('required')).toBe(false);
  });

  it('送信中は送信ボタンが無効', () => {
    setup(true);
    expect((screen.getByRole('button', { name: '送信する' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('空白のみの一言は comment を含めない', () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: '星5' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 5, aspectCodes: [] });
  });
});

/** 星の読み上げ名の正典。順序に依存しない集合として比較する。 */
const STAR_NAMES = ['星1', '星2', '星3', '星4', '星5'] as const;

/** 星をすべて掴む。読み上げ名の前方一致で拾うので、余分な星が増えれば件数に現れる。 */
function allStars(): HTMLElement[] {
  return screen.getAllByRole('button', { name: /^星/ });
}

function classesOf(element: Element): string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/).filter((value) => value.length > 0);
}

/** 正典 7.1 が星に使わないと定めた色。実値ではなく「使わない」という判断がここの対象である。 */
const FORBIDDEN_STAR_INK = ['text-primary', 'text-border'] as const;

/** 星ごとの読み上げ名と、その時点のユーティリティの控え（後の再描画で書き換わらない写し）。 */
function starPaint(): { name: string | null; utilities: string[] }[] {
  return allStars().map((star) => ({
    name: star.getAttribute('aria-label'),
    utilities: classesOf(star),
  }));
}

/** 本文色・補足色の有無だけを取り出す（順序つきで丸ごと比較するため）。 */
function inkAndMuted({ name, utilities }: { name: string | null; utilities: string[] }) {
  return {
    name,
    ink: utilities.includes('text-foreground'),
    muted: utilities.includes('text-muted-foreground'),
  };
}

// 意匠の適用（ui-airbnb-surfaces task 4.1）が壊しうる契約を、件数と集合で固定する
// （Requirements 7.2 / 7.4）。
//
// **既存 8 件との重なりを正確に書いておく。** 単数形の `getByRole` は複数一致で
// `TestingLibraryElementError: Found multiple elements` を投げるため、要素が 2 つに増えれば
// 既存の検証も赤くなる。実測（2026-09-06・変異を当てて計数）:
//
//   記入欄を 2 つにする   → 既存 8 件のうち 4 件が赤
//   通知を 2 つにする     → 既存 8 件のうち 1 件が赤
//   星を 6 個にする       → 既存 8 件のうち **0 件**が赤
//   部品を素の要素へ戻す  → 既存 8 件のうち **0 件**が赤（役割も読み上げ名も保たれるため）
//
// したがって本 describe が足す値は次の 3 点に限られる。
//   (a) 失敗が「個数が違う」と読めること。既存が落ちる理由は "Found multiple elements" であって
//       個数の表明ではなく、原因の切り分けを読み手に委ねている
//   (b) `data-slot` による**部品を通っていることの表明**。素の要素への差し戻しは既存の網に
//       1 つも掛からない
//   (c) **星の個数だけ**は既存が一切縛っていなかったこと。既存は「星4 が在る」等の包含しか
//       要求しておらず、6 個目の星も押下状態の多重化も素通りする
describe('回答フォーム: 着手前から在った契約（意匠の適用で壊しうる）', () => {
  it('星は 5 個ちょうどで、読み上げ名の集合が 星1〜星5 と相等する', () => {
    setup();
    // 包含（1〜5 がすべて在る）。改名・欠落を落とす。
    for (const name of STAR_NAMES) {
      expect(screen.getByRole('button', { name }), `${name} を掴めません`).toBeTruthy();
    }
    // 逆向きの包含（余分が無い）。包含だけでは 6 個目の星が素通りする。
    expect(allStars(), '星の個数が 5 個ではありません').toHaveLength(STAR_NAMES.length);
  });

  it('星 3 を押すと押下状態はちょうど 1 個で、字形は ★ が 3 個・☆ が 2 個になる', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: '星3' }));

    const stars = allStars();
    expect(stars, '星の個数が 5 個ではありません').toHaveLength(STAR_NAMES.length);

    // 押下状態は「いま何個目を選んだか」を伝えるものなので、真になるのは 1 個だけである。
    // 塗りの範囲（n <= star）と取り違えると 3 個が押下状態になり、支援技術には
    // 「3 つ選ばれている」と読まれる。
    const pressed = stars
      .filter((star) => star.getAttribute('aria-pressed') === 'true')
      .map((star) => star.getAttribute('aria-label'));
    expect(pressed, '押下状態の星が 1 個ではありません').toEqual(['星3']);

    // 色だけに頼らない区別（Requirement 4.7）。字形が状態を持つことを固定する。
    const glyphs = stars.map((star) => star.textContent);
    expect(glyphs.filter((glyph) => glyph === '★'), `字形: ${glyphs.join('')}`).toHaveLength(3);
    expect(glyphs.filter((glyph) => glyph === '☆'), `字形: ${glyphs.join('')}`).toHaveLength(2);
  });

  it('記入欄はちょうど 1 つで、複数行入力の部品を通っている', () => {
    setup();
    const boxes = screen.getAllByRole('textbox');
    expect(boxes, '記入欄の個数が 1 つではありません').toHaveLength(1);
    expect(boxes[0]!.tagName).toBe('TEXTAREA');
    // 素の <textarea> への逆戻りを落とす。同じ役割が面内で 2 通りに描かれる状態を作らない。
    expect(boxes[0]!.getAttribute('data-slot'), '複数行入力が部品を通っていません').toBe('textarea');
  });

  it('必須の読み上げ通知はちょうど 1 つで、通知の部品を通っている', () => {
    setup();
    // 押す前は 0 件。ここを置かないと「常に出ている通知」でも下の 1 件が成立する。
    expect(screen.queryAllByRole('alert'), '押す前から通知が出ています').toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '送信する' }));

    const alerts = screen.queryAllByRole('alert');
    expect(alerts, 'ライブリージョンの個数が 1 つではありません').toHaveLength(1);
    expect(alerts[0]!.getAttribute('data-slot'), '通知が部品を通っていません').toBe('alert');
    // 相等で固定する。包含だと文言の後付け（「※」「必須」などの追記）が素通りし、
    // 読み上げられる名前を変えないという要求（Requirement 3.2）を守れない。
    expect(alerts[0]!.textContent).toBe('満足度を選択してください');
  });

  it('主操作はちょうど 1 つで、送信中は無効になる', () => {
    setup();
    expect(
      screen.getAllByRole('button', { name: '送信する' }),
      '主操作の個数が 1 つではありません',
    ).toHaveLength(1);

    cleanup();
    setup(true);
    expect(
      (screen.getByRole('button', { name: '送信する' }) as HTMLButtonElement).disabled,
      '送信中に無効化されていません',
    ).toBe(true);
  });
});

// 正典 `docs/design/design-language.md` の §7.10 / §7.11 を面の側から守る。
// 正典は「面の側に書かないこと」を定めており、書いてしまっても描画は成立するため、
// 検証が無ければ違反は誰にも見えない。
describe('回答フォーム: 正典 docs/design/design-language.md を守るガード', () => {
  it('星の色を分岐の両端で固定する（正典 7.1）', () => {
    setup();

    // **否定の前に非空アンカーを置く。** 星を 1 つも掴めていないと、以下の
    // 「禁じられた色を持たない」はすべて空振りしたまま緑になる。
    const unselected = starPaint();
    expect(unselected, '星を 1 つも掴めていません').toHaveLength(STAR_NAMES.length);

    // 押す前。5 個すべてが補足色で、本文色は 1 つも無い。
    expect(unselected.map(inkAndMuted), '押す前の星の色').toEqual(
      STAR_NAMES.map((name) => ({ name, ink: false, muted: true })),
    );

    fireEvent.click(screen.getByRole('button', { name: '星3' }));

    const selected = starPaint();
    expect(selected, '押した後に星を 1 つも掴めていません').toHaveLength(STAR_NAMES.length);

    // 押した後。選択済み（1〜3）は本文色、未選択（4〜5）は補足色。
    // 順序も固定する。塗りの向きが反転する改変（n >= star）を落とすため。
    expect(selected.map(inkAndMuted), '星 3 を押した後の星の色').toEqual([
      { name: '星1', ink: true, muted: false },
      { name: '星2', ink: true, muted: false },
      { name: '星3', ink: true, muted: false },
      { name: '星4', ink: false, muted: true },
      { name: '星5', ink: false, muted: true },
    ]);

    // 正典 7.1 が名指しで退けた 2 色が、どちらの分岐にも現れないこと。
    //   アクション色 — 意匠差し替え後は赤であり、満足度評価が赤い星になる
    //   罫線色       — 純装飾として定義された色で、状態を伝える字形の色には足りない
    for (const phase of [
      { label: '押す前', paints: unselected },
      { label: '押した後', paints: selected },
    ]) {
      for (const { name, utilities } of phase.paints) {
        for (const forbidden of FORBIDDEN_STAR_INK) {
          expect(utilities, `${phase.label}の ${name}: ${utilities.join(' ')}`).not.toContain(
            forbidden,
          );
        }
      }
    }
  });

  it('主操作の寸法区分を面の側で上書きしない（正典 7.10）', () => {
    setup();
    const submit = screen.getByRole('button', { name: '送信する' });

    // 客向け面の主操作は拡大の区分（正典 7.10）。実値は部品が持つのでここには書かない。
    expect(submit.getAttribute('data-size'), '主操作が拡大の区分ではありません').toBe('lg');

    // 部品が自分で持つユーティリティを差し引き、**面の側が足した分だけ**を取り出す。
    // 実値を転記せずに「面が足したもの」を見るため、部品の cva をそのまま呼ぶ。
    const own = new Set(buttonVariants({ size: 'lg' }).split(/\s+/).filter((c) => c.length > 0));
    const extras = classesOf(submit).filter((utility) => !own.has(utility));

    // **否定の前に非空アンカーを置く。** 差し引きが壊れて空配列になると、
    // 下の判定は何も検査しないまま緑になる。全幅（正典 7.9）は面の側の指定である。
    expect(extras, '面の側が足したユーティリティを 1 つも読み取れていません').toContain('w-full');

    // 高さ・内側余白・文字寸法は区分の側の値であり、面の側に書いた時点でこの面だけが区分の外へ出る。
    const DIMENSION = /^(?:min-|max-)?h-|^p[xytrbles]?-|^text-(?:xs|sm|base|lg|[2-9]?xl)$/;
    expect(
      extras.filter((utility) => DIMENSION.test(utility)),
      `面の側が足したユーティリティ: ${extras.join(' ')}`,
    ).toEqual([]);
  });

  it('状態変化の色遷移を持ち、縮小も動き低減の打ち消しも書かない（正典 7.11）', () => {
    setup();
    const stars = allStars();
    expect(stars, '星を 1 つも掴めていません').toHaveLength(STAR_NAMES.length);

    for (const star of stars) {
      const utilities = classesOf(star).join(' ');
      const where = `${star.getAttribute('aria-label')}: ${utilities}`;
      // 遷移させる性質を名指しする。まとめて指定すると後から足した性質が巻き込まれる。
      expect(utilities, where).toContain('transition-colors');
      expect(utilities, where).toContain('duration-150');
      expect(utilities, where).not.toContain('transition-all');
      // 押下の沈み込みは押しボタンの部品が持つ。縮小を重ねると同じ役割が 2 通りになる。
      expect(utilities, where).not.toContain('scale');
      // 動き低減の打ち消しは theme.css の @layer base が一括で効かせる。面の側には書かない。
      expect(utilities, where).not.toContain('motion-reduce');
    }
  });
});

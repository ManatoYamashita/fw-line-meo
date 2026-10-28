// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
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

/**
 * 設問の群（fieldset の見出しが名前になる group）の中へ絞る。良かった点と気になった点は同じ観点を
 * 同じ読み上げ名で持つので、群を指定しないと単数形の getByRole が複数一致で落ちる（Issue #221）。
 */
function inGroup(name: string) {
  return within(screen.getByRole('group', { name }));
}

/** 星を 1 つ掴む。読み上げ名は「星N：言葉」なので番号の前方一致で引く。 */
function pickStar(n: number): HTMLElement {
  return screen.getByRole('radio', { name: new RegExp(`^星${n}：`) });
}

function setup(submitting = false) {
  const onSubmit = vi.fn();
  render(<SurveyForm aspects={ASPECTS} onSubmit={onSubmit} submitting={submitting} />);
  return { onSubmit };
}

describe('SurveyForm', () => {
  it('星のみで送信できる（aspectCodes 空）', () => {
    const { onSubmit } = setup();
    fireEvent.click(pickStar(5));
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 5, aspectCodes: [], concernCodes: [] });
  });

  it('星なしでは送信できず必須エラーを表示する', () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('満足度を選択してください')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('星＋良かった点＋一言を送信する', () => {
    const { onSubmit } = setup();
    fireEvent.click(pickStar(4));
    fireEvent.click(inGroup('良かった点').getByRole('checkbox', { name: '味' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'おいしい' } });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({
      star: 4,
      aspectCodes: ['taste'],
      concernCodes: [],
      comment: 'おいしい',
    });
  });

  it('良かった点は選択・解除できる', () => {
    const { onSubmit } = setup();
    fireEvent.click(pickStar(3));
    const taste = inGroup('良かった点').getByRole('checkbox', { name: '味' });
    fireEvent.click(taste); // 選択
    fireEvent.click(taste); // 解除
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 3, aspectCodes: [], concernCodes: [] });
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
    expect((screen.getByRole('button', { name: '口コミ文を作成しています…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('空白のみの一言は comment を含めない', () => {
    const { onSubmit } = setup();
    fireEvent.click(pickStar(5));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 5, aspectCodes: [], concernCodes: [] });
  });

  // ---- 気になった点（Issue #221）----------------------------------------------------------

  it('気になった点を選んで送信できる（良かった点とは別の群）', () => {
    const { onSubmit } = setup();
    fireEvent.click(pickStar(1));
    fireEvent.click(inGroup('気になった点').getByRole('checkbox', { name: '接客' }));
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 1, aspectCodes: [], concernCodes: ['service'] });
  });

  it('同じ観点を良かった点と気になった点の両方で選べる（互いの選択を消さない）', () => {
    const { onSubmit } = setup();
    fireEvent.click(pickStar(3));
    fireEvent.click(inGroup('良かった点').getByRole('checkbox', { name: '味' }));
    fireEvent.click(inGroup('気になった点').getByRole('checkbox', { name: '味' }));
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 3, aspectCodes: ['taste'], concernCodes: ['taste'] });
  });

  it('2 つの群は同じ観点を同じ順序で持つ（Requirement 2.4・同じ重みで尋ねる）', () => {
    setup();
    const names = (group: string) =>
      inGroup(group)
        .getAllByRole('checkbox')
        .map((box) => box.getAttribute('aria-labelledby'))
        .map((id) => (id === null ? null : document.getElementById(id)?.textContent ?? null));
    expect(names('良かった点')).toEqual(['味', '接客']);
    expect(names('気になった点')).toEqual(names('良かった点'));
  });

  // Requirement 2.11: 素材の集め方を評価で分岐させない。星を選ぶ前・星 1・星 5 のいずれでも、
  // 設問の見出しの集合と順序が同じであることを固定する。星で出し分ける改変はここで落ちる。
  it('設問の見出しの集合と順序は星の値で変わらない', () => {
    setup();
    const legends = () => screen.getAllByRole('group').map((g) => g.querySelector('legend')?.textContent);
    const before = legends();
    expect(before).toEqual(['満足度（必須）', '良かった点', '気になった点']);
    fireEvent.click(pickStar(1));
    expect(legends()).toEqual(before);
    fireEvent.click(pickStar(5));
    expect(legends()).toEqual(before);
  });

  it('観点の読み上げ名を指す id は文書内で重複しない（2 群が同じ観点を持つため）', () => {
    setup();
    const ids = screen
      .getAllByRole('checkbox')
      .map((box) => box.getAttribute('aria-labelledby'))
      .filter((id): id is string => id !== null);
    // 非空アンカー。1 つも掴めていなければ下の「重複なし」は空振りで成立する。
    expect(ids, '観点のチェックボックスを掴めていません').toHaveLength(ASPECTS.length * 2);
    expect(new Set(ids).size, `id が重複しています: ${ids.join(', ')}`).toBe(ids.length);
    for (const id of ids) expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
  });
});

/**
 * 星の読み上げ名の正典（Issue #492）。番号に言葉を添える。順序に依存しない集合として比較する。
 * 部品の STAR_LABELS から組み立てずに書き写すのは、部品側の言葉の改変をここで捕まえるため。
 */
const STAR_NAMES = ['星1：不満', '星2：やや不満', '星3：ふつう', '星4：満足', '星5：とても満足'] as const;

/** 星をすべて掴む。読み上げ名の前方一致で拾うので、余分な星が増えれば件数に現れる。 */
function allStars(): HTMLElement[] {
  return screen.getAllByRole('radio', { name: /^星/ });
}

function classesOf(element: Element): string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/).filter((value) => value.length > 0);
}

/** 星の字形（SVG）。塗りと縁の色はここに付く。 */
function glyphOf(star: HTMLElement): SVGSVGElement {
  const glyph = star.querySelector('svg');
  if (glyph === null) throw new Error(`${star.getAttribute('aria-label')} の字形を掴めません`);
  return glyph;
}

/** 星ごとの読み上げ名と、その時点の点灯状態（後の再描画で書き換わらない写し）。 */
function starLit(): { name: string | null; lit: string | null }[] {
  return allStars().map((star) => ({
    name: star.getAttribute('aria-label'),
    lit: glyphOf(star).getAttribute('data-lit'),
  }));
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
  it('星は 5 個ちょうどで、読み上げ名の集合が 星1〜星5 の言葉つきの名前と相等する', () => {
    setup();
    // 包含（1〜5 がすべて在る）。改名・欠落を落とす。
    for (const name of STAR_NAMES) {
      expect(screen.getByRole('radio', { name }), `${name} を掴めません`).toBeTruthy();
    }
    // 逆向きの包含（余分が無い）。包含だけでは 6 個目の星が素通りする。
    expect(allStars(), '星の個数が 5 個ではありません').toHaveLength(STAR_NAMES.length);
    // 5 個は 1 つの radiogroup に属し、群の名前は設問の見出しである。
    const group = screen.getByRole('radiogroup', { name: '満足度（必須）' });
    expect(within(group).getAllByRole('radio'), '群の中の星が 5 個ではありません').toHaveLength(STAR_NAMES.length);
  });

  it('星 3 を押すと選択状態はちょうど 1 個で、塗りは 3 個・縁だけが 2 個になる', () => {
    setup();
    fireEvent.click(pickStar(3));

    const stars = allStars();
    expect(stars, '星の個数が 5 個ではありません').toHaveLength(STAR_NAMES.length);

    // 選択状態は「いま何個目を選んだか」を伝えるものなので、真になるのは 1 個だけである。
    // 塗りの範囲（n <= star）と取り違えると 3 個が選択状態になり、支援技術には
    // 「3 つ選ばれている」と読まれる。
    const checked = stars
      .filter((star) => star.getAttribute('aria-checked') === 'true')
      .map((star) => star.getAttribute('aria-label'));
    expect(checked, '選択状態の星が 1 個ではありません').toEqual(['星3：ふつう']);

    // 色だけに頼らない区別（Requirement 4.7）。塗るか縁だけかという形の差が状態を持つことを、
    // 順序つきで固定する（塗りの向きが反転する改変 n >= star を落とす）。
    expect(starLit().map(({ lit }) => lit), '星 3 を押した後の点灯').toEqual(['true', 'true', 'true', 'false', 'false']);
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

    const alerts = document.querySelectorAll<HTMLElement>('[data-slot="alert"]');
    expect(alerts, '案内の個数が 1 つではありません').toHaveLength(1);
    expect(alerts[0]!.getAttribute('role'), '結果は Toast が読み上げる').toBeNull();
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
      (screen.getByRole('button', { name: '口コミ文を作成しています…' }) as HTMLButtonElement).disabled,
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
    const glyphs = allStars().map(glyphOf);
    expect(glyphs, '星を 1 つも掴めていません').toHaveLength(STAR_NAMES.length);

    // 点灯していない星は塗らずに補足色の縁だけ、点灯した星はブランド色で塗りアクション色で縁取る。
    // 状態の切り替えは字形の data-lit が担い、色はその変種として 5 個すべてが同じ組を持つ。
    for (const glyph of glyphs) {
      const utilities = classesOf(glyph);
      for (const required of [
        'fill-transparent',
        'stroke-muted-foreground',
        'data-[lit=true]:fill-brand',
        'data-[lit=true]:stroke-primary',
      ]) {
        expect(utilities, `字形の色の組: ${utilities.join(' ')}`).toContain(required);
      }
    }

    // 分岐の両端。押す前は 5 個とも消灯、星 3 を押した後は 1〜3 が点灯・4〜5 が消灯。
    expect(starLit(), '押す前の点灯').toEqual(STAR_NAMES.map((name) => ({ name, lit: 'false' })));
    fireEvent.click(pickStar(3));
    expect(starLit(), '星 3 を押した後の点灯').toEqual(
      STAR_NAMES.map((name, i) => ({ name, lit: String(i < 3) })),
    );

    // 正典 7.1 が退けた色が、変種の有無を問わず現れないこと。
    //   アクション色の塗り — 星が押しボタンと同じ色の面になり、評価が操作の対象に見える
    //   ブランド色の縁     — 白背景に対して 3:1 に届かず、図形の境界（WCAG 1.4.11）を担えない
    //   罫線色             — 純装飾として定義された色で、状態を伝える字形の色には足りない
    //   文字色の指定       — 字形は SVG で描くので、文字色は塗りにも縁にも届かない
    const FORBIDDEN = /^(?:fill-primary|stroke-brand|fill-border|stroke-border|text-[a-z-]+)$/;
    for (const glyph of allStars().map(glyphOf)) {
      const offenders = classesOf(glyph)
        .map((utility) => utility.replace(/^data-\[lit=true\]:/, ''))
        .filter((utility) => FORBIDDEN.test(utility));
      expect(offenders, `字形のユーティリティ: ${classesOf(glyph).join(' ')}`).toEqual([]);
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
      const glyph = classesOf(glyphOf(star)).join(' ');
      const where = `${star.getAttribute('aria-label')}: ${glyph}`;
      // 遷移させる性質を名指しする。まとめて指定すると後から足した性質が巻き込まれる。
      expect(glyph, where).toContain('transition-colors');
      expect(glyph, where).toContain('duration-150');
      expect(glyph, where).not.toContain('transition-all');

      // 星の部分木のどこにも、縮小のユーティリティと動き低減の打ち消しを書かない。
      // 持ち上がりと確定時のポップは指の追従として inline の transform で描き、動き低減は
      // 部品が JS で判定する（正典 7.11 の例外）。クラスで書くと、押下の沈み込みと同じ役割が
      // 2 通りになるか、theme.css の @layer base の一括抑制と二重管理になる。
      const subtree = [star, ...star.querySelectorAll('*')].flatMap(classesOf);
      expect(subtree.filter((utility) => /(?:^|:)scale-/.test(utility)), where).toEqual([]);
      expect(subtree.filter((utility) => utility.includes('motion-reduce')), where).toEqual([]);
    }
  });
});

// 星の操作（Issue #492）。radiogroup としてキーボードで選べ、支援技術の仮想クリック
// （pointer を伴わない click）でも確定すること。原作の Peek Rating は pointerup とキーボードでしか
// 確定しないため、click の受け口が消えると VoiceOver などから選べなくなる。
describe('回答フォーム: 星の操作', () => {
  /** いま Tab で星の群へ入ったときに焦点を受ける星（tabIndex が 0 の星）の読み上げ名。 */
  const tabStops = () =>
    allStars()
      .filter((star) => star.tabIndex === 0)
      .map((star) => star.getAttribute('aria-label'));
  const checkedName = () =>
    allStars()
      .filter((star) => star.getAttribute('aria-checked') === 'true')
      .map((star) => star.getAttribute('aria-label'));

  it('Tab で入れる星は 1 個だけ。未選択では先頭、選択後は選んだ星', () => {
    setup();
    expect(tabStops(), '未選択の Tab の入口').toEqual(['星1：不満']);
    fireEvent.click(pickStar(4));
    expect(tabStops(), '星 4 を選んだ後の Tab の入口').toEqual(['星4：満足']);
  });

  it('矢印キー・Home・End で選び、選んだ星へ焦点が移る。先頭より前へは戻らない（取り消さない）', () => {
    const { onSubmit } = setup();
    const group = screen.getByRole('radiogroup', { name: '満足度（必須）' });
    const press = (key: string, expected: string) => {
      fireEvent.keyDown(document.activeElement ?? group, { key });
      expect(checkedName(), `${key} の後の選択`).toEqual([expected]);
      expect(document.activeElement?.getAttribute('aria-label'), `${key} の後の焦点`).toBe(expected);
    };

    pickStar(1).focus();
    press('ArrowRight', '星1：不満');
    press('ArrowRight', '星2：やや不満');
    press('End', '星5：とても満足');
    press('ArrowLeft', '星4：満足');
    press('Home', '星1：不満');
    press('ArrowLeft', '星1：不満');

    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 1, aspectCodes: [], concernCodes: [] });
  });

  it('pointer を伴わない click で確定し、同じ星をもう一度押しても取り消さない', () => {
    const { onSubmit } = setup();
    // fireEvent.click は detail 0 の click（支援技術の仮想クリックと同じ形）を送る。
    fireEvent.click(pickStar(2));
    fireEvent.click(pickStar(2));
    expect(checkedName()).toEqual(['星2：やや不満']);
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(onSubmit).toHaveBeenCalledWith({ star: 2, aspectCodes: [], concernCodes: [] });
  });

  it('必須の案内は星の群から説明として参照され、星を選ぶと消える', () => {
    setup();
    const group = screen.getByRole('radiogroup', { name: '満足度（必須）' });
    expect(group.getAttribute('aria-required')).toBe('true');
    expect(group.hasAttribute('aria-describedby'), '案内が出る前から説明を参照しています').toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    const describedBy = group.getAttribute('aria-describedby');
    expect(describedBy, '案内が群から参照されていません').not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toBe('満足度を選択してください');

    fireEvent.click(pickStar(5));
    expect(group.hasAttribute('aria-describedby')).toBe(false);
    expect(screen.queryByText('満足度を選択してください')).toBeNull();
  });
});

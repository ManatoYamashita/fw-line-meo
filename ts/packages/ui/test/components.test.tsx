// @vitest-environment jsdom
//
// 共通コンポーネントの a11y・状態表現スモークテスト（タスク 6.2）。
// design.md「Testing Strategy」Unit 3「components.test.tsx」/ Requirements 2.1, 2.3, 2.4, 5.1。
//
// 本テストが守る契約は 3 つ:
//  1. 役割と状態が支援技術へ正しく公開される（role / aria-checked / aria-disabled / aria-invalid）
//     — Requirements 2.4, 5.1
//  2. キーボードのみで操作が完結する（Tab でフォーカス・Space/Enter/矢印で操作）
//     — Requirements 2.4
//  3. 視覚状態（hover / focus / disabled / エラー）が variant と data 属性の規約で表現され、
//     支援技術向け状態（aria-*）と同期する — Requirements 2.3
//
// 注: jsdom は Tailwind を解決しないため「見た目」そのものは検証できない。よって視覚状態は
// 「その状態を分岐させるユーティリティクラス・data 属性が存在すること」で検証する
// （＝状態表現が規約に沿って宣言されていることの検証。実際の描画は #43〜#45 の目視と E2E が担う）。
import type { ReactElement } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Alert, AlertDescription, AlertTitle } from '../src/components/alert';
import { Button } from '../src/components/button';
import { Checkbox } from '../src/components/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '../src/components/field';
import { Heading } from '../src/components/heading';
import { Input } from '../src/components/input';
import { RadioGroup, RadioGroupItem } from '../src/components/radio-group';
import { Spinner } from '../src/components/spinner';
import { Textarea } from '../src/components/textarea';

// jsdom 25 は PointerEvent を実装していない。一方 Base UI の Checkbox は、キーボード/クリックの
// 活性化を隠し input へ `new PointerEvent('click')` で転送する（CheckboxRoot の onClick）。
// 実ブラウザには必ず存在する API のため、環境差を埋める最小の互換実装を用意する
// （コンポーネントの挙動を書き換えるものではなく、テスト環境の欠落を補うだけ）。
if (!('PointerEvent' in window)) {
  class PointerEventPolyfill extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', {
    value: PointerEventPolyfill,
    configurable: true,
    writable: true,
  });
}

afterEach(cleanup);

/** 生の色指定（hex・Tailwind パレット色クラス）— 意味論トークン経由でない色の検出用。 */
const RAW_HEX = /#[0-9a-fA-F]{3,8}/;
const RAW_PALETTE_COLOR =
  /\b(?:bg|text|border|ring|outline|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;

function classesOf(element: Element): string {
  return element.getAttribute('class') ?? '';
}

describe('Button — 役割・キーボード完結・状態表現（Requirements 2.3, 2.4, 5.1）', () => {
  it('button ロールで公開され、キーボードのみ（Tab → Enter / Space）で起動できる', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>送信する</Button>);

    const button = screen.getByRole('button', { name: '送信する' });

    // マウスを一切使わずフォーカスできること。
    await user.tab();
    expect(document.activeElement).toBe(button);

    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);

    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('disabled は DOM と支援技術の双方へ通知され、キーボードで到達できない', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        送信する
      </Button>,
    );

    const button = screen.getByRole('button', { name: '送信する' });
    expect(button.hasAttribute('disabled')).toBe(true);
    // 視覚状態の分岐に使う data 属性（Base UI 規約）。
    expect(button.hasAttribute('data-disabled')).toBe(true);

    await user.tab();
    expect(document.activeElement).not.toBe(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('hover / disabled / エラーの各状態が状態バリアントのクラスとして宣言されている', () => {
    render(<Button>送信する</Button>);
    const classes = classesOf(screen.getByRole('button', { name: '送信する' }));

    expect(classes).toContain('hover:bg-primary-hover'); // hover
    expect(classes).toContain('disabled:opacity-50'); // disabled
    expect(classes).toContain('aria-invalid:border-destructive'); // エラー（aria-invalid 駆動）
  });

  it('variant / size の切り替えが見た目クラスに反映され、色は意味論トークン経由のみ', () => {
    render(
      <>
        <Button>既定</Button>
        <Button variant="destructive">削除</Button>
        <Button size="sm">小</Button>
      </>,
    );

    const defaultClasses = classesOf(screen.getByRole('button', { name: '既定' }));
    const destructiveClasses = classesOf(screen.getByRole('button', { name: '削除' }));
    const smallClasses = classesOf(screen.getByRole('button', { name: '小' }));

    expect(defaultClasses).toContain('bg-primary');
    expect(destructiveClasses).toContain('text-destructive');
    expect(destructiveClasses).not.toContain('bg-primary');
    expect(smallClasses).toContain('h-7');
    expect(smallClasses).not.toContain('h-8');

    for (const classes of [defaultClasses, destructiveClasses, smallClasses]) {
      expect(classes).not.toMatch(RAW_HEX);
      expect(classes).not.toMatch(RAW_PALETTE_COLOR);
    }
  });
});

describe('Checkbox — 役割・キーボード完結・状態同期（Requirements 2.3, 2.4, 5.1）', () => {
  it('checkbox ロールと aria-checked を公開し、キーボードのみ（Tab → Space）で切り替えできる', async () => {
    const user = userEvent.setup();
    render(<Checkbox name="taste" aria-label="味" />);

    const checkbox = screen.getByRole('checkbox', { name: '味' });
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    expect(checkbox.hasAttribute('data-unchecked')).toBe(true);

    await user.tab();
    expect(document.activeElement).toBe(checkbox);

    await user.keyboard(' ');
    // 支援技術向け状態と視覚状態用 data 属性が同時に切り替わること。
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    expect(checkbox.hasAttribute('data-checked')).toBe(true);

    await user.keyboard(' ');
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    expect(checkbox.hasAttribute('data-checked')).toBe(false);
  });

  it('disabled は aria-disabled で通知され、キーボードで到達できない', async () => {
    const user = userEvent.setup();
    render(<Checkbox name="taste" aria-label="味" disabled />);

    const checkbox = screen.getByRole('checkbox', { name: '味' });
    expect(checkbox.getAttribute('aria-disabled')).toBe('true');
    expect(checkbox.hasAttribute('data-disabled')).toBe(true);

    await user.tab();
    expect(document.activeElement).not.toBe(checkbox);
  });

  it('エラー状態は aria-invalid で通知され、同じ属性が視覚状態も分岐させる', () => {
    render(<Checkbox name="taste" aria-label="味" aria-invalid />);

    const checkbox = screen.getByRole('checkbox', { name: '味' });
    expect(checkbox.getAttribute('aria-invalid')).toBe('true');
    // 視覚状態は aria-invalid セレクタで分岐する（支援技術状態と視覚状態の単一起点）。
    expect(classesOf(checkbox)).toContain('aria-invalid:border-destructive');
  });
});

describe('RadioGroup — 役割・矢印キー操作（Requirements 2.4, 5.1）', () => {
  it('radiogroup / radio ロールを公開し、キーボードのみ（Tab → 矢印）で選択できる', async () => {
    const user = userEvent.setup();
    render(
      <RadioGroup name="rating" aria-label="満足度">
        <RadioGroupItem value="good" aria-label="良い" />
        <RadioGroupItem value="bad" aria-label="悪い" />
      </RadioGroup>,
    );

    expect(screen.getByRole('radiogroup', { name: '満足度' })).toBeDefined();
    const good = screen.getByRole('radio', { name: '良い' });
    const bad = screen.getByRole('radio', { name: '悪い' });

    await user.tab();
    expect(document.activeElement).toBe(good);

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(bad);
    expect(bad.getAttribute('aria-checked')).toBe('true');
    expect(bad.hasAttribute('data-checked')).toBe(true);
    expect(good.getAttribute('aria-checked')).toBe('false');
  });
});

describe('Field — ラベル関連付けと data-invalid / aria-invalid の同期（Requirements 2.3, 5.1）', () => {
  function renderField(invalid: boolean) {
    render(
      <Field data-invalid={invalid ? 'true' : undefined}>
        <FieldLabel htmlFor="store-name">店舗名</FieldLabel>
        <Input id="store-name" aria-invalid={invalid || undefined} />
        <FieldDescription>正式名称を入力してください</FieldDescription>
        {invalid ? <FieldError>店舗名は必須です</FieldError> : null}
      </Field>,
    );
    return {
      field: screen.getByRole('group'),
      input: screen.getByRole('textbox', { name: '店舗名' }),
    };
  }

  it('group ロールを持ち、ラベルがコントロールのアクセシブル名になる', () => {
    const { field, input } = renderField(false);
    expect(field.getAttribute('data-slot')).toBe('field');
    // getByRole の name 一致（renderField 内）がラベル関連付けの証拠。
    expect(input.getAttribute('id')).toBe('store-name');
  });

  it('正常時は data-invalid も aria-invalid も立たず、エラー通知も描画されない', () => {
    const { field, input } = renderField(false);
    expect(field.hasAttribute('data-invalid')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('エラー時は Field の data-invalid とコントロールの aria-invalid が同期する', () => {
    const { field, input } = renderField(true);

    expect(field.getAttribute('data-invalid')).toBe('true');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    // 視覚状態（Field 配下の文字色）と支援技術状態が同じ真偽で駆動されること。
    expect(field.getAttribute('data-invalid') === 'true').toBe(
      input.getAttribute('aria-invalid') === 'true',
    );

    // 視覚状態は data-invalid セレクタで分岐する（shadcn Field 規約）。
    expect(classesOf(field)).toContain('data-[invalid=true]:text-destructive');

    // エラー本文は role="alert" で支援技術へ通知される。
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-slot')).toBe('field-error');
    expect(alert.textContent).toBe('店舗名は必須です');
  });

  it('disabled 状態は data-disabled とコントロールの disabled で同期表現される', () => {
    render(
      <Field data-disabled="true">
        <FieldLabel htmlFor="locked">店舗名</FieldLabel>
        <Input id="locked" disabled />
      </Field>,
    );

    const field = screen.getByRole('group');
    const input = screen.getByRole('textbox', { name: '店舗名' });
    expect(field.getAttribute('data-disabled')).toBe('true');
    expect(input.hasAttribute('disabled')).toBe(true);
    // ラベルの淡色化は Field の data-disabled を起点にする（規約の単一起点）。
    expect(classesOf(screen.getByText('店舗名'))).toContain(
      'group-data-[disabled=true]/field:opacity-50',
    );
  });
});

describe('Alert — 通知（成功 / エラー）の役割と変種（Requirements 2.1, 2.3, 5.1）', () => {
  it('alert ロールで通知され、見出しと本文が読み上げ対象になる', () => {
    render(
      <Alert>
        <AlertTitle>登録しました</AlertTitle>
        <AlertDescription>店舗情報を保存しました</AlertDescription>
      </Alert>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('登録しました');
    expect(alert.textContent).toContain('店舗情報を保存しました');
  });

  it('成功（success）とエラー（destructive）が別変種として区別できる', () => {
    render(
      <>
        <Alert variant="success">
          <AlertTitle>成功</AlertTitle>
        </Alert>
        <Alert variant="destructive">
          <AlertTitle>失敗</AlertTitle>
        </Alert>
      </>,
    );

    const [success, destructive] = screen.getAllByRole('alert');
    expect(success).toBeDefined();
    expect(destructive).toBeDefined();

    // 成功はブランド緑をそのまま文字色にしない（#1DB446 は白背景で 2.74:1 = AA 非準拠）。
    // 意味論トークン --success（= AA 準拠の primary）経由の text-success を使う。
    expect(classesOf(success!)).toContain('text-success');
    expect(classesOf(success!)).not.toContain('text-brand');
    expect(classesOf(destructive!)).toContain('text-destructive');
    expect(classesOf(success!)).not.toBe(classesOf(destructive!));
  });

  it('全変種が意味論トークンのみを使い、生の色（hex / パレット色クラス）を持たない', () => {
    render(
      <>
        <Alert>
          <AlertTitle>既定</AlertTitle>
        </Alert>
        <Alert variant="success">
          <AlertTitle>成功</AlertTitle>
        </Alert>
        <Alert variant="destructive">
          <AlertTitle>失敗</AlertTitle>
        </Alert>
      </>,
    );

    for (const alert of screen.getAllByRole('alert')) {
      expect(classesOf(alert)).not.toMatch(RAW_HEX);
      expect(classesOf(alert)).not.toMatch(RAW_PALETTE_COLOR);
    }
  });
});

describe('Heading — ページ見出しの役割と階層（Requirements 2.1, 3.1, 5.1）', () => {
  it('heading ロールで公開され、支援技術に見出しとして通知される', () => {
    render(<Heading level={1}>店舗の詳細</Heading>);

    const heading = screen.getByRole('heading', { name: '店舗の詳細' });
    expect(heading.getAttribute('data-slot')).toBe('heading');
  });

  it('level が <h1>〜<h6> のセマンティック要素に対応する', () => {
    render(
      <>
        <Heading level={1}>レベル1</Heading>
        <Heading level={2}>レベル2</Heading>
        <Heading level={3}>レベル3</Heading>
        <Heading level={4}>レベル4</Heading>
        <Heading level={5}>レベル5</Heading>
        <Heading level={6}>レベル6</Heading>
      </>,
    );

    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      const heading = screen.getByRole('heading', { name: `レベル${level}`, level });
      expect(heading.tagName).toBe(`H${level}`);
      // 見出しレベルは支援技術（role/level）と視覚階層（data-level）の単一起点で表現する。
      expect(heading.getAttribute('data-level')).toBe(String(level));
    }
  });

  it('level ごとに異なるサイズユーティリティが既定で当たり、視覚階層が生まれる', () => {
    render(
      <>
        <Heading level={1}>レベル1</Heading>
        <Heading level={2}>レベル2</Heading>
        <Heading level={3}>レベル3</Heading>
      </>,
    );

    const sizes = ([1, 2, 3] as const).map((level) =>
      classesOf(screen.getByRole('heading', { name: `レベル${level}`, level })),
    );

    // typography トークンのサイズ階層（--text-2xl / --text-xl / --text-lg）由来のユーティリティ。
    expect(sizes[0]).toContain('text-2xl');
    expect(sizes[1]).toContain('text-xl');
    expect(sizes[2]).toContain('text-lg');
    expect(new Set(sizes).size).toBe(3);
  });

  it('size で既定のサイズ階層を上書きでき、要素の意味論（level）とは独立している', () => {
    render(
      <Heading level={3} size="2xl">
        大きく見せる第3階層
      </Heading>,
    );

    const heading = screen.getByRole('heading', { name: '大きく見せる第3階層', level: 3 });
    expect(heading.tagName).toBe('H3');
    expect(classesOf(heading)).toContain('text-2xl');
    expect(classesOf(heading)).not.toContain('text-lg');
  });

  it('全レベルが意味論トークンのみを使い、生の色（hex / パレット色クラス）を持たない', () => {
    render(
      <>
        <Heading level={1}>レベル1</Heading>
        <Heading level={2}>レベル2</Heading>
        <Heading level={3}>レベル3</Heading>
        <Heading level={4}>レベル4</Heading>
        <Heading level={5}>レベル5</Heading>
        <Heading level={6}>レベル6</Heading>
      </>,
    );

    for (const heading of screen.getAllByRole('heading')) {
      expect(classesOf(heading)).not.toMatch(RAW_HEX);
      expect(classesOf(heading)).not.toMatch(RAW_PALETTE_COLOR);
    }
  });
});

describe('Spinner — 読み込み中の状態通知（Requirements 2.1, 5.1）', () => {
  it('status ロールと日本語のアクセシブル名を持つ', () => {
    render(<Spinner />);

    const spinner = screen.getByRole('status');
    // 本プロダクトの UI 言語は日本語（lang="ja"）。読み上げ名も日本語で提供する。
    expect(spinner.getAttribute('aria-label')).toBe('読み込み中');
  });

  it('呼び出し側が用途に応じたアクセシブル名へ差し替えられる', () => {
    render(<Spinner aria-label="下書きを生成中" />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('下書きを生成中');
  });
});

// フォーカス指標の一本化（Issue #49 / Requirements 5.3）。
//
// theme.css は `@layer base` にグローバルな `:focus-visible { outline: 2px solid var(--ring) }` を
// アクセシビリティ既定として宣言している。ところがベンダリング元の shadcn 部品は base class に
// `outline-none` を持ち、これは `@layer utilities` に生成されるため **詳細度に関係なくレイヤ順で
// base に勝ち**、既定は「それが守るべき対話的部品の上でだけ」無効化されていた。
// 残る指標も `ring-ring/50`（白背景 2.08:1）や destructive の `border-destructive/40`（1.93:1）と
// SC 1.4.11 の 3:1 を満たしておらず、default Button では `border-ring` が自身の塗り（bg-primary）と
// 同色になって完全に不可視だった。
//
// 是正方針は「部品は focus を自前定義せず、theme.css の base outline に一本化する」。
// 本テストはその契約をクラス宣言レベルで固定する（実コンパイル結果は app-integration.test.ts、
// 実描画は survey-web の E2E が担う）。
describe('フォーカス指標は部品が自前定義しない（Issue #49 / Requirements 5.3）', () => {
  /** `outline-none` は base レイヤの既定を打ち消すため、部品では一切許さない。 */
  const OUTLINE_SUPPRESSION = /\boutline-none\b/;
  /** 部品ごとの focus 上書き（variant ごとに指標の強さがばらつく原因）も許さない。 */
  const SELF_DECLARED_FOCUS = /focus-visible:(?:ring|border|outline)-/;

  const cases: ReadonlyArray<{ readonly name: string; readonly element: ReactElement }> = [
    { name: 'Button（default）', element: <Button>既定</Button> },
    { name: 'Button（destructive）', element: <Button variant="destructive">削除</Button> },
    { name: 'Button（outline）', element: <Button variant="outline">枠線</Button> },
    { name: 'Input', element: <Input aria-label="入力" /> },
    { name: 'Textarea', element: <Textarea aria-label="複数行入力" /> },
    { name: 'Checkbox', element: <Checkbox aria-label="同意する" /> },
  ];

  for (const { name, element } of cases) {
    it(`${name} は outline-none も focus-visible の自前指標も持たない`, () => {
      const { container } = render(element);
      const classes = [...container.querySelectorAll('*')]
        .map((node) => classesOf(node))
        .join(' ');

      expect(
        classes,
        `${name} が outline-none を持っています。base レイヤの :focus-visible 既定が` +
          '打ち消され、この要素ではフォーカスが不可視になります',
      ).not.toMatch(OUTLINE_SUPPRESSION);
      expect(
        classes,
        `${name} が focus-visible の指標を自前定義しています。` +
          'フォーカス表現は theme.css の base outline に一本化してください',
      ).not.toMatch(SELF_DECLARED_FOCUS);
    });
  }

  it('RadioGroupItem も同様（RadioGroup 経由でのみ描画できるため個別に検証する）', () => {
    const { container } = render(
      <RadioGroup aria-label="評価">
        <RadioGroupItem value="good" aria-label="良い" />
      </RadioGroup>,
    );
    const classes = [...container.querySelectorAll('*')].map((node) => classesOf(node)).join(' ');

    expect(classes).not.toMatch(OUTLINE_SUPPRESSION);
    expect(classes).not.toMatch(SELF_DECLARED_FOCUS);
  });

  it('エラー状態のリング（aria-invalid）は残す（フォーカスとは別概念のため）', () => {
    // outline = フォーカス / ring = エラー、という役割分担を固定する。
    render(<Input aria-label="メール" aria-invalid />);
    const classes = classesOf(screen.getByLabelText('メール'));
    expect(classes).toContain('aria-invalid:border-destructive');
  });
});

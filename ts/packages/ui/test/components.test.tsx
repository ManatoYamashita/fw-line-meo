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
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('success / destructive は説明文にも同じ状態色を渡す（PR #56 レビュー指摘1）', () => {
    render(
      <>
        <Alert variant="success">
          <AlertTitle>成功</AlertTitle>
          <AlertDescription>店舗情報を保存しました</AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <AlertTitle>失敗</AlertTitle>
          <AlertDescription>店舗情報を保存できませんでした</AlertDescription>
        </Alert>
      </>,
    );

    // AlertDescription は自身に text-muted-foreground を持つ。したがって variant の状態色は
    // 親に text-<状態色> を置くだけでは説明文へ届かず、子孫指定で明示的に渡す必要がある。
    // この指定を消しても親のクラス集合は壊れないため、他のガードは全て緑のまま通る。
    expect(classesOf(screen.getByText('店舗情報を保存しました'))).toContain(
      'text-muted-foreground',
    );

    const [success, destructive] = screen.getAllByRole('alert');
    const cases = [
      { alert: success!, color: 'success' },
      { alert: destructive!, color: 'destructive' },
    ];
    for (const { alert, color } of cases) {
      const classes = classesOf(alert);
      expect(classes, `variant の状態色 text-${color} が親に無い`).toContain(`text-${color}`);
      expect(
        classes,
        `説明文へ text-${color} を渡す子孫指定が無い（説明文が灰色のまま描画される）`,
      ).toContain(`*:data-[slot=alert-description]:text-${color}`);
    }

    // 不透明度を掛けると白背景での実効値が AA を割る（success 4.17:1 / destructive 4.30:1）。
    // 数値の検証は contrast-usage.test.ts が行うので、ここでは形だけを落とす。
    for (const { alert } of cases) {
      expect(
        classesOf(alert),
        '説明文への色指定に不透明度が付いている（Issue #50 の再発）',
      ).not.toMatch(/data-\[slot=alert-description\]:text-[a-z-]+\/\d+/);
    }
  });

  it('既定（default）の説明文は状態色を持たず muted のままである', () => {
    render(
      <Alert>
        <AlertTitle>お知らせ</AlertTitle>
        <AlertDescription>変更はありません</AlertDescription>
      </Alert>,
    );

    expect(classesOf(screen.getByRole('alert'))).not.toContain('data-[slot=alert-description]:text-');
    expect(classesOf(screen.getByText('変更はありません'))).toContain('text-muted-foreground');
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

// --- 動きに関わる指定の分類ガード（Requirements 1.4, 5.5） -----------------------------
//
// 動き低減設定下の抑制は theme.css の 1 箇所で全部品に一律に効く。だからこそ、部品へ
// 新しい動きが加わったときに「それは抑制してよい動きなのか」が誰にも問われないまま
// 通ってしまう。ここでは部品ソースから動きに関わる指定を全抽出し、下表と双方向で
// 突き合わせて未分類を必ず赤化させる。
//
// 分類は 2 区分である（design「動きの 2 区分」）。この区別を曖昧にすると、要件 1.2 を
// 守ったつもりで要件 1.4 を破る:
//   progress（経過）  = アニメーション・遷移の所要時間や反復。抑制してよい
//   endstate（到達状態）= 状態変化の結果として適用される位置・不透明度・色などの最終値。
//                        抑制すると「動きではなく状態」が失われる。抑制してはならない
const motionComponentsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'components',
);
const motionThemeCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'theme.css'),
  'utf8',
);

/**
 * 動きに関わるユーティリティの本体パターン。
 * `data-slot="spinner"` のような **クラスでない文字列**を拾わないよう、キーワードの直後に
 * 区切りか終端を要求する（"spinner" は誤検出しない）。
 */
const MOTION_UTILITY_PATTERN =
  /^-?(?:animate|transition|duration|ease|translate|scale|rotate|skew)(?:-|$)/;

interface MotionClassification {
  /** 部品ソースに現れる完全なクラス（variant 連鎖を含む）。 */
  readonly utility: string;
  readonly kind: 'progress' | 'endstate';
  /**
   * endstate のみ: この指定が実際に出力する CSS プロパティ。
   * theme.css の抑制ブロックがこれを宣言していないことを検証する。
   * Tailwind v4 の translate-* は `transform` ではなく `translate` へ出力される点に注意
   * （生成 CSS で確認済み。`transform` を見張っても実際の経路は素通りする）。
   */
  readonly cssProperty?: string;
  readonly note: string;
}

const MOTION_CLASSIFICATIONS: readonly MotionClassification[] = [
  {
    utility: 'animate-spin',
    kind: 'progress',
    note: 'Spinner の無限回転。動き低減設定下で最も止めるべき対象',
  },
  { utility: 'transition-all', kind: 'progress', note: 'Button / Badge の状態遷移' },
  {
    utility: 'transition-colors',
    kind: 'progress',
    note: 'Input / Textarea / Checkbox の色遷移',
  },
  {
    utility: 'transition-none',
    kind: 'progress',
    note: 'Checkbox のチェック表示。もともと遷移させない指定であり抑制と衝突しない',
  },
  {
    utility: 'active:not-aria-[haspopup]:translate-y-px',
    kind: 'endstate',
    cssProperty: 'translate',
    note: '押下時の沈み込み。これは「動き」ではなく押している間の状態表現であり、'
      + '止めると押した手応えが失われる（要件 1.4）',
  },
  {
    utility: '-translate-x-1/2',
    kind: 'endstate',
    cssProperty: 'translate',
    note: 'RadioGroupItem の選択マークを中央へ置く静的配置。状態変化ですらない',
  },
  {
    utility: '-translate-y-1/2',
    kind: 'endstate',
    cssProperty: 'translate',
    note: '同上',
  },
  {
    utility: '*:[svg]:translate-y-0.5',
    kind: 'endstate',
    cssProperty: 'translate',
    note: 'Alert のアイコンを本文の行と揃える静的配置',
  },
];

/** 部品ソースから動きに関わるクラスを全て抽出する（variant 連鎖を保持したまま返す）。 */
function extractMotionUtilities(source: string): readonly string[] {
  const found: string[] = [];
  for (const token of source.split(/[\s"'`]+/)) {
    // variant 連鎖（`active:` `*:[svg]:` 等）を落としてユーティリティ本体だけを判定する。
    const utility = token.slice(token.lastIndexOf(':') + 1);
    if (MOTION_UTILITY_PATTERN.test(utility)) found.push(token);
  }
  return found;
}

/**
 * theme.css の動き抑制ブロックが宣言しているプロパティを取り出す。
 * 波括弧の深さを数えて対応する閉じ括弧までを切り出す（入れ子があるため正規表現では取れない）。
 */
function suppressedPropertiesInTheme(css: string): ReadonlySet<string> {
  const marker = '@media (prefers-reduced-motion: reduce)';
  const start = css.indexOf(marker);
  if (start < 0) return new Set();
  let depth = 0;
  let end = start;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = css.slice(start, end);
  return new Set([...block.matchAll(/([a-z-]+)\s*:\s*[^;]+;/g)].map((match) => match[1]!));
}

describe('動きに関わる指定が 2 区分へ漏れなく分類されている（Requirements 1.4, 5.5）', () => {
  const extracted = new Set<string>();
  for (const file of readdirSync(motionComponentsDir).filter((name) => name.endsWith('.tsx'))) {
    for (const utility of extractMotionUtilities(
      readFileSync(join(motionComponentsDir, file), 'utf8'),
    )) {
      extracted.add(utility);
    }
  }
  const classified = new Set(MOTION_CLASSIFICATIONS.map((entry) => entry.utility));

  it('抽出が空振りしていない（部品から動きの指定が消えたのではないことの確認）', () => {
    expect(
      extracted.size,
      '部品から動きに関わる指定が 1 つも抽出できませんでした。抽出器が壊れているか、' +
        '部品の書き方が変わっています。分類ガードは対象ゼロでは何も守れません',
    ).toBeGreaterThan(0);
  });

  it('抽出器が data-slot 等のクラスでない文字列を拾わない（自己検証）', () => {
    const fixture = 'data-slot="spinner" className="animate-spin transition-all rotating"';
    expect(extractMotionUtilities(fixture)).toEqual(['animate-spin', 'transition-all']);
  });

  it('部品にあって分類表に無い指定が存在しない（新しい動きの混入を検出する）', () => {
    const unclassified = [...extracted].filter((utility) => !classified.has(utility));
    expect(
      unclassified,
      `分類されていない動きの指定があります: ${unclassified.join(', ')}。` +
        'それが抑制してよい「経過」なのか、抑制してはならない「到達状態」なのかを' +
        'MOTION_CLASSIFICATIONS へ明記してください',
    ).toEqual([]);
  });

  it('分類表にあって部品に無い指定が存在しない（死んだ項目を残さない）', () => {
    const stale = [...classified].filter((utility) => !extracted.has(utility));
    expect(
      stale,
      `部品から消えた指定が分類表に残っています: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('到達状態に分類した指定が theme.css の抑制対象へ紛れ込んでいない（Requirements 1.4）', () => {
    const suppressed = suppressedPropertiesInTheme(motionThemeCss);
    expect(
      suppressed.size,
      'theme.css から抑制ブロックを取り出せません（抑制が失われたか、書式が変わりました）',
    ).toBeGreaterThan(0);

    for (const entry of MOTION_CLASSIFICATIONS) {
      if (entry.kind !== 'endstate') continue;
      expect(entry.cssProperty, `${entry.utility} に cssProperty の宣言がありません`).toBeDefined();
      expect(
        suppressed.has(entry.cssProperty!),
        `${entry.utility} が出力する ${entry.cssProperty} を theme.css が抑制しています。` +
          `これは到達状態であり抑制してはなりません（${entry.note}）`,
      ).toBe(false);
    }
  });
});

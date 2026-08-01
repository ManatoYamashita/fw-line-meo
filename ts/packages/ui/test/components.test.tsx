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

import postcss from 'postcss';
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

/**
 * 描画済みの Alert を引く。
 *
 * role で引いてはならない。読み上げ強度は変種ごとに変わる（destructive のみ alert・
 * それ以外は status）ため、role で引くと変種によって取れたり取れなかったりする。
 * 視覚表現の検証は読み上げ強度から独立しているべきなので data-slot を使う。
 */
function renderedAlerts(): readonly Element[] {
  return [...document.querySelectorAll('[data-slot="alert"]')];
}

describe('Alert — 通知（成功 / エラー）の役割と変種（Requirements 2.1, 2.3, 5.1）', () => {
  it('ライブリージョンとして通知され、見出しと本文が読み上げ対象になる', () => {
    render(
      <Alert>
        <AlertTitle>登録しました</AlertTitle>
        <AlertDescription>店舗情報を保存しました</AlertDescription>
      </Alert>,
    );

    const alert = renderedAlerts()[0]!;
    expect(
      LIVE_REGION_ROLES.has(alert.getAttribute('role') ?? ''),
      `Alert の役割 ${alert.getAttribute('role') ?? '（無し）'} がライブリージョンではありません`,
    ).toBe(true);
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

    const [success, destructive] = renderedAlerts();
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

    const [success, destructive] = renderedAlerts();
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

    expect(classesOf(renderedAlerts()[0]!)).not.toContain('data-[slot=alert-description]:text-');
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

    for (const alert of renderedAlerts()) {
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

  // 以下は DOM 構造の変更（単一要素 → ラッパ構造）を跨いで守るべき契約
  // （ui-a11y-gaps Requirements 2.2, 2.3）。構造に依存しない言い方で固定する。

  it('className は「実際に動く要素」へ届く（視覚的な大きさの指定が迷子にならない）', () => {
    // 呼び出し側は <Spinner className="size-8" /> を「アイコンの大きさ」の意図で書く。
    // ラッパ構造へ変えたときに className をラッパへ付けると、アイコンの寸法は変わらないまま
    // **無言で意図が失われる**（画面は壊れず、誰も気づけない）。
    // 「動きを持つ要素＝視覚的な本体」に付くことを、要素名を名指しせずに要求する。
    const { container } = render(<Spinner className="size-8" />);
    const animated = [...container.querySelectorAll('*')].filter((node) =>
      classesOf(node).includes('animate-spin'),
    );
    expect(animated.length, 'animate-spin を持つ要素が見つかりません').toBe(1);
    expect(
      classesOf(animated[0]!),
      '呼び出し側の className が、動きを持つ視覚的な本体へ届いていません',
    ).toContain('size-8');
  });

  it('呼び出し側の任意の属性が根要素へ透過する', () => {
    render(<Spinner data-testid="生成中" />);
    expect(screen.getByRole('status').getAttribute('data-testid')).toBe('生成中');
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
 *
 * 文字列の切り出しと正規表現では取れない。CSS には **宣言と同じ形をしていて宣言ではないもの**
 * が混ざるためで、素朴に `プロパティ: 値;` を拾うと次の 2 つを宣言として誤認する:
 *   1. メディア条件 `prefers-reduced-motion: reduce` そのもの。前置きを含んだまま走査すると
 *      これが最初の宣言として一致し、値の側が次の `;` まで伸びて **直後の第 1 宣言を丸ごと
 *      食い潰す**（先頭に置かれた到達状態の抑制が無言で素通りする）
 *   2. `.x:hover` のような擬似クラスを持つ選択子
 * どちらも構文木を辿れば起こらない。app-integration.test.ts の `mediaRulesInLayer` と同じく、
 * 宣言であることを構文で判定する（文字列上の見た目で判定しない）。
 */
function suppressedPropertiesInTheme(css: string): ReadonlySet<string> {
  const properties = new Set<string>();
  postcss.parse(css).walkAtRules('media', (media) => {
    if (!/prefers-reduced-motion\s*:\s*reduce/.test(media.params)) return;
    media.walkDecls((declaration) => properties.add(declaration.prop));
  });
  return properties;
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

  it('抽出器が抑制ブロックの宣言だけを漏れなく拾う（自己検証）', () => {
    // ここが空振りすると、下の「紛れ込んでいない」判定は **見ていないものを見たと報告する**。
    // 罠は 2 つあり、いずれも「宣言に見えるが宣言でないもの」を宣言として拾うことで起きる:
    //   1. メディア条件 `prefers-reduced-motion: reduce` 自体が「プロパティ: 値」の形をしている。
    //      前置きを含んだまま走査すると、これが最初の宣言として一致し、直後の
    //      **第 1 宣言を丸ごと食い潰す**（先頭に置かれた到達状態の抑制が素通りする）。
    //   2. `.x:hover` のような擬似クラスを持つ選択子も同じ形をしている。
    // 到達状態が抑制ブロックのどこに書かれても検出できることを、先頭・入れ子の両方で固定する。
    const fixture = [
      '@layer base{',
      '  @media (prefers-reduced-motion: reduce){',
      '    *,::before,::after{',
      '      translate: none !important;',
      '      animation-duration: 0.01ms !important;',
      '    }',
      '    .x:hover{ color: red; }',
      '  }',
      '}',
    ].join('\n');
    expect(
      [...suppressedPropertiesInTheme(fixture)].sort(),
      '抑制ブロックの宣言を、先頭の 1 件も含めて漏れなく取り出せていません',
    ).toEqual(['animation-duration', 'color', 'translate']);
  });

  it('抽出器が実ファイルでも宣言でないものを拾わない（自己検証）', () => {
    const suppressed = suppressedPropertiesInTheme(motionThemeCss);
    expect(
      suppressed.has('prefers-reduced-motion'),
      'メディアクエリの条件を宣言として拾っています（前置きを切り落とせていません）',
    ).toBe(false);
    expect(
      suppressed.has('animation-duration'),
      '抑制ブロックの第 1 宣言を取りこぼしています（前置きが直後の宣言を食い潰しています）',
    ).toBe(true);
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

// --- 通知の読み上げ強度の出し分け（Requirements 3.1〜3.4, 5.2） -------------------------
//
// すべての通知が読み上げを即座に中断する強度（role="alert"）で提示されると、単なる案内文でも
// スクリーンリーダー利用者の作業が毎回遮られる。一方でエラーは確実に気づけなければならない。
// ここでは「エラーだけが割り込む」ことと、「どの変種も読み上げ対象から外れない」ことを固定する。

/** ライブリージョンとして扱われる role。どの変種もこのいずれかでなければならない（要件 3.4）。 */
const LIVE_REGION_ROLES: ReadonlySet<string> = new Set(['alert', 'status']);
/** 進行中の読み上げを中断させる強度。 */
const ASSERTIVE_ROLE = 'alert';

type AlertVariant = 'default' | 'success' | 'destructive';

/** 変種 → 既定の読み上げ強度。エラーのみ割り込ませる（2026-07-30 の利用者合意）。 */
const ALERT_ROLE_BY_VARIANT: Readonly<Record<AlertVariant, string>> = {
  default: 'status',
  success: 'status',
  destructive: ASSERTIVE_ROLE,
};

/**
 * cva の variants グループ（`variant: { … }` 等）の直下キーを部品ソースから取り出す。
 *
 * 判定は **行単位** で行う。クラス文字列には `:` も `[` も引用符も含まれるため
 * （`*:[svg:not([class*='size-'])]:size-4` 等）、文字単位で `key:` を探すと誤検出する。
 * 一方 cva の変種キーは必ず行頭に現れ、クラス文字列の折り返し行は引用符で始まるので、
 * 「行頭の識別子 + コロン」だけを拾えば十分に堅い。
 *
 * 注意: キーの直前に説明コメントが挟まることがある（`alert.tsx` の success がそう）。
 * コメント行は行頭が識別子ではないため自然に除外される。カンマ直後を起点にする実装では
 * この success を取りこぼした（実際に踏んだ）。
 */
function variantKeysOf(source: string, group: string): readonly string[] {
  const start = source.indexOf(`${group}: {`);
  if (start < 0) return [];
  const open = source.indexOf('{', start);

  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];

  const keys: string[] = [];
  let nested = 0;
  for (const line of source.slice(open + 1, end).split('\n')) {
    if (nested === 0) {
      const match = /^"?([A-Za-z_][\w-]*)"?\s*:/.exec(line.trim());
      if (match !== null) keys.push(match[1]!);
    }
    nested +=
      (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
  }
  return keys;
}

const alertSource = readFileSync(join(motionComponentsDir, 'alert.tsx'), 'utf8');

describe('Alert — 読み上げ強度が重要度に応じて出し分けられる（Requirements 3.1〜3.4, 5.2）', () => {
  it('部品が提供する変種と対応表が双方向で一致する（強度未定義の変種を作らない）', () => {
    const declared = variantKeysOf(alertSource, 'variant');
    expect(
      declared.length,
      '変種を抽出できませんでした（抽出器が壊れているか部品の書き方が変わっています）',
    ).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual(Object.keys(ALERT_ROLE_BY_VARIANT).sort());
  });

  it.each(Object.keys(ALERT_ROLE_BY_VARIANT) as AlertVariant[])(
    '%s 変種が意図した読み上げ強度で提示される',
    (variant) => {
      render(
        <Alert variant={variant} data-testid="通知">
          <AlertTitle>見出し</AlertTitle>
        </Alert>,
      );
      const role = screen.getByTestId('通知').getAttribute('role');
      expect(
        role,
        `${variant} 変種の読み上げ強度が ${role ?? '（無し）'} です。` +
          `${ALERT_ROLE_BY_VARIANT[variant]} であるべきです`,
      ).toBe(ALERT_ROLE_BY_VARIANT[variant]);
    },
  );

  it('割り込む強度を持つのはエラーだけである（案内文で作業を中断させない）', () => {
    const interrupting = (Object.keys(ALERT_ROLE_BY_VARIANT) as AlertVariant[]).filter(
      (variant) => ALERT_ROLE_BY_VARIANT[variant] === ASSERTIVE_ROLE,
    );
    expect(
      interrupting,
      `読み上げを割り込ませる変種: ${interrupting.join(', ')}。エラーのみであるべきです`,
    ).toEqual(['destructive']);
  });

  it('読み上げ対象から外れる変種が存在しない（Requirements 3.4）', () => {
    for (const variant of Object.keys(ALERT_ROLE_BY_VARIANT) as AlertVariant[]) {
      expect(
        LIVE_REGION_ROLES.has(ALERT_ROLE_BY_VARIANT[variant]),
        `${variant} 変種の役割 ${ALERT_ROLE_BY_VARIANT[variant]} はライブリージョンではありません。` +
          'その変種の通知は支援技術へ一切伝わらなくなります',
      ).toBe(true);
    }
  });

  it('呼び出し側が読み上げ強度を上書きできる', () => {
    render(
      <Alert variant="default" role="alert" data-testid="通知">
        <AlertTitle>緊急</AlertTitle>
      </Alert>,
    );
    expect(screen.getByTestId('通知').getAttribute('role')).toBe('alert');
  });

  it('読み上げ強度の出し分けが視覚表現を変えない（Requirements 3.3）', () => {
    // 「変更前と同一か」を literal のクラス文字列で固定するとレイアウト調整のたびに壊れる。
    // ここでは要件の文言どおり **読み上げ強度の違いによって視覚表現が変わらないこと** を
    // 直接測る: 同じ変種を既定の強度と上書きした強度で描画し、クラス集合が一致することを見る。
    for (const variant of Object.keys(ALERT_ROLE_BY_VARIANT) as AlertVariant[]) {
      const { container: withDefaultRole } = render(
        <Alert variant={variant}>
          <AlertTitle>見出し</AlertTitle>
          <AlertDescription>説明</AlertDescription>
        </Alert>,
      );
      const { container: withOverriddenRole } = render(
        <Alert variant={variant} role="log">
          <AlertTitle>見出し</AlertTitle>
          <AlertDescription>説明</AlertDescription>
        </Alert>,
      );
      const classesIn = (root: Element): string =>
        [...root.querySelectorAll('*')].map((node) => classesOf(node)).join(' | ');
      const baseline = classesIn(withDefaultRole);
      // 空振り防止: 両方が空文字なら「一致」は自明に成立してしまう。
      expect(baseline.length, `${variant} 変種のクラスを読み取れていません`).toBeGreaterThan(20);
      expect(
        classesIn(withOverriddenRole),
        `${variant} 変種の視覚表現が読み上げ強度によって変化しています`,
      ).toBe(baseline);
      cleanup();
    }
  });
});

// --- 寸法区分の分類ガード（Requirements 5.4） ------------------------------------------
//
// タッチ操作領域の要求値は寸法区分ごとに異なる（客向け主動線の既定寸法は 44px、高density
// 配置向けの縮小寸法は SC 2.5.8 の 24px）。区分が追加されたときに「どちらに属するのか」を
// 誰も宣言しないまま通ると、その区分だけが検証の網から漏れる。
//
// 実際の px の実測は survey-web の E2E が行う（jsdom は Tailwind を解決しないため）。
// ここでは「区分の網羅」と「分類と実装の対応」を固定する。E2E 側にも区分 → 要求 px の表が
// あるが、片方だけずらしても必ずどちらかが落ちる: 縮小区分に 44px を要求すれば実測が、
// 既定区分に 24px を要求すれば下の拡張面の検査が赤化する。
const BUTTON_SIZE_CLASS = {
  default: 'default',
  lg: 'default',
  icon: 'default',
  'icon-lg': 'default',
  xs: 'compact',
  sm: 'compact',
  'icon-xs': 'compact',
  'icon-sm': 'compact',
} as const satisfies Record<string, 'default' | 'compact'>;

type ButtonSize = keyof typeof BUTTON_SIZE_CLASS;

const buttonSource = readFileSync(join(motionComponentsDir, 'button.tsx'), 'utf8');

describe('押しボタンの寸法区分が漏れなく分類されている（Requirements 5.4）', () => {
  it('部品が提供する寸法区分と分類表が双方向で一致する', () => {
    const declared = variantKeysOf(buttonSource, 'size');
    expect(
      declared.length,
      '寸法区分を抽出できませんでした（抽出器が壊れているか部品の書き方が変わっています）',
    ).toBeGreaterThan(0);

    const classified = Object.keys(BUTTON_SIZE_CLASS);
    const unclassified = declared.filter((size) => !classified.includes(size));
    expect(
      unclassified,
      `いずれの要求値に属するか宣言されていない寸法区分があります: ${unclassified.join(', ')}。` +
        '44px を要求する既定寸法なのか、24px を下限とする縮小寸法なのかを明記してください',
    ).toEqual([]);

    const stale = classified.filter((size) => !declared.includes(size));
    expect(stale, `部品から消えた寸法区分が分類表に残っています: ${stale.join(', ')}`).toEqual([]);
  });

  it.each(Object.keys(BUTTON_SIZE_CLASS) as ButtonSize[])(
    '%s の操作領域の拡張の有無が分類と一致する',
    (size) => {
      render(
        <Button size={size} aria-label="ボタン">
          押す
        </Button>,
      );
      const classes = classesOf(screen.getByRole('button', { name: 'ボタン' }));
      const hasExpansion = /after:-inset-/.test(classes);
      const shouldExpand = BUTTON_SIZE_CLASS[size] === 'default';
      expect(
        hasExpansion,
        shouldExpand
          ? `${size} は既定寸法だが操作領域の拡張を持たない（44px に届かない）`
          : `${size} は縮小寸法だが操作領域の拡張を持つ（密集配置で隣の視覚領域を覆う）`,
      ).toBe(shouldExpand);
      // 拡張は不可視の面で行い、部品自身の視覚寸法は変えない（Requirements 4.3）。
      if (shouldExpand) {
        expect(
          classes,
          `${size} の拡張面が絶対配置されていない（レイアウトフローに載ると周囲の余白が動く）`,
        ).toContain('after:absolute');
        expect(classes, `${size} に配置の基準が無く拡張面が本体を基準にできない`).toContain(
          'relative',
        );
      }
    },
  );
});

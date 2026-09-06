// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Alert } from '@fwlm/ui/components/alert';
import { buttonVariants } from '@fwlm/ui/components/button';
import { cn } from '@fwlm/ui/lib/utils';
import { Textarea } from '@fwlm/ui/components/textarea';
import { DraftPanel } from '../src/app/s/[storeId]/draft-panel';
import type { DraftPanelProps } from '../src/app/s/[storeId]/types';
import { announcedText, ownText } from './live-region';

const URL = 'https://search.google.com/local/writereview?placeid=ChIJ';

function props(over: Partial<DraftPanelProps> = {}): DraftPanelProps {
  return {
    draft: '良いお店でした。',
    generationFailed: false,
    regenerationsLeft: 3,
    googleReviewUrl: URL,
    onRegenerate: vi.fn(),
    regenerating: false,
    ...over,
  };
}

function stubClipboard(writeText: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('navigator', { clipboard: { writeText } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  stubClipboard(vi.fn().mockResolvedValue(undefined));
});

describe('DraftPanel', () => {
  it('下書きを編集可能な textarea に表示する（3.7）', () => {
    render(<DraftPanel {...props()} />);
    const ta = screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement;
    expect(ta.value).toBe('良いお店でした。');
  });

  it('編集後、コピーは編集済みテキストを writeText に渡す（4.2）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<DraftPanel {...props()} />);
    fireEvent.change(screen.getByLabelText('口コミ下書き'), { target: { value: '編集後の文章' } });
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    expect(writeText).toHaveBeenCalledWith('編集後の文章');
    expect(await screen.findByText(/コピーしました/)).toBeDefined();
  });

  it('clipboard 未提供時も手動コピーのフォールバックを表示する（4.6）', () => {
    vi.stubGlobal('navigator', {});
    render(<DraftPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    expect(screen.getByText(/手動でコピー/)).toBeDefined();
  });

  it('writeText 失敗時は手動コピーのフォールバックを表示する（4.6）', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    stubClipboard(writeText);
    render(<DraftPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    expect(await screen.findByText(/手動でコピー/)).toBeDefined();
  });

  it('再生成ボタンで onRegenerate を呼ぶ／残 0 で無効', () => {
    const onRegenerate = vi.fn();
    const { rerender } = render(<DraftPanel {...props({ onRegenerate })} />);
    fireEvent.click(screen.getByRole('button', { name: /別の文章を生成/ }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    rerender(<DraftPanel {...props({ onRegenerate, regenerationsLeft: 0 })} />);
    expect((screen.getByRole('button', { name: /別の文章を生成/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('生成中は「生成中…」を表示し再生成を無効化（3.6）', () => {
    render(<DraftPanel {...props({ regenerating: true })} />);
    expect(screen.getByText('生成中…')).toBeDefined();
    expect((screen.getByRole('button', { name: /別の文章を生成/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('生成失敗時は失敗メッセージ＋再試行＋投稿導線を表示する（3.9）', () => {
    render(<DraftPanel {...props({ generationFailed: true })} />);
    expect(screen.getByRole('alert').textContent).toContain('失敗');
    expect(screen.getByRole('button', { name: /もう一度生成/ })).toBeDefined();
    expect(screen.getByRole('link', { name: /クチコミを書く/ }).getAttribute('href')).toBe(URL);
  });

  it('投稿導線は全状態で表示され star 分岐が無い（4.4・ゲーティング不在）', () => {
    const { rerender } = render(<DraftPanel {...props()} />);
    expect(screen.getByRole('link', { name: /クチコミを書く/ }).getAttribute('href')).toBe(URL);
    rerender(<DraftPanel {...props({ generationFailed: true })} />);
    expect(screen.getByRole('link', { name: /クチコミを書く/ }).getAttribute('href')).toBe(URL);
  });

  it('draft prop 変更（再生成到着）で textarea が更新される', () => {
    const { rerender } = render(<DraftPanel {...props({ draft: '最初' })} />);
    expect((screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement).value).toBe('最初');
    rerender(<DraftPanel {...props({ draft: '再生成後' })} />);
    expect((screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement).value).toBe('再生成後');
  });
});

// ---- ここから ui-airbnb-surfaces task 4.2 が追加した検証 ----

/** 生成中の文言。三点リーダは U+2026。既存検証（`getByText('生成中…')`）と同じ値を指す。 */
const GENERATING = '生成中…';
const COPIED = 'コピーしました。投稿画面に貼り付けてください。';
const MANUAL = '自動コピーできませんでした。上の文章を選択して手動でコピーしてください。';
const FAILED = '下書きの生成に失敗しました。再試行するか、そのまま投稿画面へお進みください。';

function classesOf(element: Element): string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/).filter((value) => value.length > 0);
}

/**
 * 穏やかな読み上げ領域を数える。**役割属性と `aria-live` の両方**を見る。
 *
 * 着手前の実装は `<p aria-live="polite">生成中…</p>` と `<p role="status">コピーしました…</p>` の
 * 2 通りを併用していた。役割だけを数えると前者が網から漏れ、「領域が 2 つ並ぶ」という当の欠陥が
 * 素通りする。`aria-hidden` の内側は支援技術から見えないので数えない（共通部品の Spinner は
 * ラッパ自身に役割を持つため、装飾として添える限りここには現れない）。
 */
const POLITE_REGION_SELECTOR = '[role="status"],[aria-live]';

function politeRegions(): Element[] {
  return Array.from(document.body.querySelectorAll(POLITE_REGION_SELECTOR)).filter(
    (element) => element.closest('[aria-hidden="true"]') === null,
  );
}

/**
 * 穏やかな読み上げ領域を 1 つに解決したうえで返す。0 個でも 2 個でも例外になる。
 *
 * **数える網は広く、解決した 1 つへの要求は厳しく。** 網を `role="status"` だけに狭めると
 * 着手前の `aria-live="polite"` 形が数から漏れる。一方、数が合っているだけでは強度を保証
 * できない。3 つの通知を 1 つの領域へ集約した以上、この領域の強度は着手前より重い責務を
 * 負っており、`assertive` へ倒すと処理中の表示までが進行中の読み上げを中断させる。
 * 中断させてよいのは生成失敗の通知だけである（design.md「Error Handling」）。
 */
function theLiveRegion(): HTMLElement {
  const regions = politeRegions();
  expect(
    regions,
    `穏やかな読み上げ領域が ${regions.length} 個あります（この面では常にちょうど 1 つ）`,
  ).toHaveLength(1);
  const region = regions[0]! as HTMLElement;
  expect(region.getAttribute('role'), '読み上げ領域の役割が status ではありません').toBe('status');
  // `status` は暗黙に polite なので明示は不要。明示するなら polite 以外は許さない。
  const live = region.getAttribute('aria-live');
  expect(
    live === null || live === 'polite',
    `読み上げ強度が穏やかではありません（aria-live=${String(live)}）`,
  ).toBe(true);
  return region;
}

/**
 * 通知の中身（常時マウントの容器の直下にある唯一の要素）。言うことが無いときは null。
 *
 * 容器と中身を分けるのは design.md「Error Handling」の割り当て（成功は通知の部品、処理中は
 * 図形）に従うためである。通知の部品は空でも枠と内側余白を描くので容器そのものにはできない。
 */
function theNoticeBody(): HTMLElement | null {
  const children = Array.from(theLiveRegion().children);
  expect(children.length, `通知の中身が ${children.length} 個あります（0 個か 1 個）`).toBeLessThanOrEqual(1);
  return (children[0] as HTMLElement | undefined) ?? null;
}

/** 通知の部品が変種ごとに持つユーティリティを、部品を素で描いて読み取る（実値を転記しない）。 */
function alertUtilities(variant?: 'success'): string[] {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(variant === undefined ? <Alert /> : <Alert variant={variant} />, { container: host });
  const classes = classesOf(host.querySelector('[data-slot="alert"]')!);
  host.remove();
  return classes;
}

/** 押しボタン部品が variant / size から自分で作るユーティリティ（面の追記を差し引く基準）。 */
function componentButtonUtilities(variant: 'default' | 'outline'): Set<string> {
  return new Set(
    buttonVariants({ variant, size: 'lg' })
      .split(/\s+/)
      .filter((value) => value.length > 0),
  );
}

/**
 * 指定の変種**だけ**が持つユーティリティ（もう一方の変種との差分）。
 * 変種を取り違えるとこれらが欠けるので、実値を転記せずに変種の取り違えを落とせる。
 */
function variantOnlyUtilities(variant: 'default' | 'outline'): string[] {
  const other = componentButtonUtilities(variant === 'default' ? 'outline' : 'default');
  return [...componentButtonUtilities(variant)].filter((utility) => !other.has(utility));
}

/** 高さ・内側余白・文字寸法。正典 7.10 が「面の側に書かない」と定めたもの。 */
const DIMENSION = /^(?:min-|max-)?h-|^p[xytrbles]?-|^text-(?:xs|sm|base|lg|[2-9]?xl)$/;

/**
 * 押しボタンが部品を通り、寸法区分を面の側で上書きしていないことを固定する（正典 7.10）。
 * 実値はここに 1 つも書かない。部品の cva をそのまま呼んで差し引き、**面が足した分**だけを見る。
 */
function expectButtonKeepsComponentSizing(
  button: HTMLElement,
  variant: 'default' | 'outline',
): void {
  expect(button.getAttribute('data-slot'), '押しボタンが部品を通っていません').toBe('button');
  expect(button.getAttribute('data-size'), '押しボタンが拡大の区分ではありません').toBe('lg');

  const utilities = classesOf(button);

  // 変種の取り違えを落とす。**否定の前に非空アンカーを置く。** 差分が空だと以下は空振りする。
  const variantOnly = variantOnlyUtilities(variant);
  expect(
    variantOnly,
    `変種 ${variant} の固有ユーティリティを 1 つも取り出せていません`,
  ).not.toEqual([]);
  for (const utility of variantOnly) {
    expect(
      utilities,
      `変種 ${variant} のユーティリティ ${utility} が描画結果にありません`,
    ).toContain(utility);
  }

  const own = componentButtonUtilities(variant);
  const extras = utilities.filter((utility) => !own.has(utility));

  // **否定の前に非空アンカーを置く。** 差し引きが壊れて空配列になると、下の判定は何も検査しない。
  expect(extras, '面の側が足したユーティリティを 1 つも読み取れていません').toContain('w-full');
  expect(
    extras.filter((utility) => DIMENSION.test(utility)),
    `面の側が足したユーティリティ: ${extras.join(' ')}`,
  ).toEqual([]);
}

// 着手前は「生成中」と「コピー結果」が別々の要素で、しかも内容と同時に DOM へ挿入されていた。
// 読み上げは領域が先に在って中身が後から変わるときに発火するので、この形では発火しない。
// さらにコピー後に再生成を押すと 2 つの領域が同時に存在した（`copyState` は `draft` が
// 変わるまで idle へ戻らない）。以下はその是正を、**状態の組み合わせ**で固定する。
//
// 既存 9 件との重なりを正確に書いておく。既存が見ているのは
// 「`getByText('生成中…')` が掴めること」「`getByRole('alert')` が単数で解決すること」
// 「`/コピーしました/` `/手動でコピー/` が現れること」だけで、**領域の個数も、領域が常時
// 在ることも、読み上げ文字列が二重でないことも、1 件も見ていない**。
describe('下書きパネル: 読み上げ領域の単一性（着手前は無検証）', () => {
  it('生成中と失敗の 4 通りのどの組み合わせでも読み上げ領域はちょうど 1 つ', () => {
    for (const failed of [false, true]) {
      for (const regen of [false, true]) {
        cleanup();
        render(<DraftPanel {...props({ generationFailed: failed, regenerating: regen })} />);
        const region = theLiveRegion();
        expect(announcedText(region), `失敗=${failed} 生成中=${regen} の読み上げ文字列`).toBe(
          regen ? GENERATING : '',
        );
      }
    }
  });

  it('読み上げ強度は穏やかなまま（進行中の読み上げを中断させない）', () => {
    // 中断させてよいのは生成失敗の通知だけ（design.md「Error Handling」）。集約した領域を
    // assertive へ倒すと、処理中もコピー結果も利用者の作業を毎回遮る。
    for (const over of [{}, { regenerating: true }, { generationFailed: true }]) {
      cleanup();
      render(<DraftPanel {...props(over)} />);
      const region = theLiveRegion(); // 役割と強度はここで検査している
      expect(region.getAttribute('role'), JSON.stringify(over)).toBe('status');
    }

    // 強い側は失われていないこと（同じ箇条書きのもう半分）。
    cleanup();
    render(<DraftPanel {...props({ generationFailed: true })} />);
    expect(screen.queryAllByRole('alert'), '中断させる通知の個数').toHaveLength(1);
  });

  it('コピー後に再生成しても読み上げ領域は 1 つのまま（生成中が勝つ）', async () => {
    const { rerender } = render(<DraftPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    expect(await screen.findByText(/コピーしました/)).toBeDefined();
    expect(announcedText(theLiveRegion()), 'コピー直後の読み上げ文字列').toBe(COPIED);

    // `draft` は変えない。着手前の実装はここで領域が 2 つ並んだ（`copyState` が idle へ戻らない）。
    rerender(<DraftPanel {...props({ regenerating: true })} />);
    expect(announcedText(theLiveRegion()), 'コピー後に再生成したときの読み上げ文字列').toBe(
      GENERATING,
    );
  });

  it('生成中でないときも読み上げ領域は残り、中身だけが空になる', () => {
    render(<DraftPanel {...props()} />);
    // 条件付きマウントへ戻す改変を落とす。領域が内容と同時に現れる形では読み上げが発火しない。
    expect(theNoticeBody(), '言うことが無いのに通知が描かれています').toBeNull();
    expect(announcedText(theLiveRegion()), '生成中でないときの読み上げ文字列').toBe('');
  });

  it('生成中の文言は直下のテキストのまま完全一致し、読み上げが二重にならない', () => {
    render(<DraftPanel {...props({ regenerating: true })} />);
    const body = theNoticeBody();
    expect(body, '処理中の通知を掴めていません').not.toBeNull();
    // 直下のテキストノード。`<Spinner aria-label="生成中…" />` の 1 要素へ畳むと空になる
    // （文言が sr-only の子へ落ち、動き低減でない実ブラウザから見えなくなる）。
    expect(ownText(body!), '生成中の可視文言').toBe(GENERATING);
    // 図形の読み上げ名が混ざっていないこと。aria-hidden を付け忘れるとここが二重になる。
    expect(announcedText(theLiveRegion()), '生成中の読み上げ文字列').toBe(GENERATING);
  });

  it('処理中の図形は装飾として添えられている（aria-hidden）', () => {
    render(<DraftPanel {...props({ regenerating: true })} />);
    const region = theLiveRegion();
    const spinner = region.querySelector('[data-slot="spinner"]');
    // **否定の前に非空アンカーを置く。** 図形を掴めていないと下の判定は空振りする。
    expect(spinner, '処理中の図形を掴めていません').not.toBeNull();
    expect(
      spinner!.getAttribute('aria-hidden'),
      '図形が読み上げ領域として二重に数えられます',
    ).toBe('true');

    cleanup();
    render(<DraftPanel {...props()} />);
    expect(
      theLiveRegion().querySelector('[data-slot="spinner"]'),
      '生成中でないのに処理中の図形が描かれています',
    ).toBeNull();
  });

  it('コピー結果の 2 通りが同じ読み上げ領域に載る', async () => {
    render(<DraftPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    expect(await screen.findByText(/コピーしました/)).toBeDefined();
    expect(announcedText(theLiveRegion()), '自動コピー成功時の読み上げ文字列').toBe(COPIED);

    cleanup();
    vi.stubGlobal('navigator', {});
    render(<DraftPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    expect(announcedText(theLiveRegion()), '手動コピー案内時の読み上げ文字列').toBe(MANUAL);
  });

  // design.md「Error Handling」の割り当て: 成功の通知は成功の変種、処理中は図形。
  // 中身が部品を通っていることと、**中身が役割を持たないこと**を対で固定する。役割を残すと
  // 容器と合わせて穏やかな読み上げ領域が 2 つになり、集約そのものが崩れる。
  it('コピー結果の通知は通知の部品を通り、中身は読み上げ役割を持たない', async () => {
    const defaultAlert = alertUtilities();
    const successAlert = alertUtilities('success');
    const successOnly = successAlert.filter((utility) => !defaultAlert.includes(utility));
    // **否定の前に非空アンカーを置く。** 差分が空だと以下の包含・非包含は両方とも空振りする。
    expect(successOnly, '成功の変種の固有ユーティリティを 1 つも取り出せていません').not.toEqual(
      [],
    );

    render(<DraftPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    expect(await screen.findByText(/コピーしました/)).toBeDefined();
    const copied = theNoticeBody()!;
    expect(copied.getAttribute('data-slot'), '成功の通知が部品を通っていません').toBe('alert');
    expect(copied.getAttribute('role'), '成功の通知が読み上げ役割を持っています').toBeNull();
    for (const utility of successOnly) {
      expect(classesOf(copied), `成功の変種の ${utility} がありません`).toContain(utility);
    }

    cleanup();
    vi.stubGlobal('navigator', {});
    render(<DraftPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    const manual = theNoticeBody()!;
    // 自動コピーが働かなかったことは成功ではないので既定の変種。
    expect(manual.getAttribute('data-slot'), '手動コピー案内が部品を通っていません').toBe('alert');
    expect(manual.getAttribute('role'), '手動コピー案内が読み上げ役割を持っています').toBeNull();
    for (const utility of successOnly) {
      expect(classesOf(manual), `手動コピー案内が成功の変種で描かれています（${utility}）`).not.toContain(
        utility,
      );
    }
    for (const utility of defaultAlert) {
      expect(classesOf(manual), `既定の変種の ${utility} がありません`).toContain(utility);
    }

    expect(
      screen.queryAllByRole('alert'),
      '生成に成功しているのに中断させる通知が出ています',
    ).toHaveLength(0);
  });
});

// 正典 `docs/design/design-language.md` の §7.9 / §7.10 を面の側から守る。
// 正典は「面の側に書かないこと」を定めており、書いてしまっても描画は成立するため、
// 検証が無ければ違反は誰にも見えない。
describe('下書きパネル: 部品を通っていることと正典 docs/design/design-language.md', () => {
  it('複数行入力が部品を通り、輪郭と内側余白と文字寸法を面の側で書き直さない', () => {
    render(<DraftPanel {...props()} />);
    const boxes = screen.getAllByRole('textbox');
    expect(boxes, '記入欄の個数が 1 つではありません').toHaveLength(1);
    const textarea = boxes[0]!;
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.getAttribute('data-slot'), '複数行入力が部品を通っていません').toBe('textarea');
    // 部品が自分で持つユーティリティは、部品を素で描いて読み取る（実値を転記しない）。
    const reference = document.createElement('div');
    document.body.appendChild(reference);
    render(<Textarea />, { container: reference });
    const own = new Set(classesOf(reference.querySelector('textarea')!));
    reference.remove();

    const extras = classesOf(textarea).filter((utility) => !own.has(utility));

    // **全文が一目で読める高さを実際に担っているのは、面の側の最小高さである。**
    // 行数は部品が内容に応じて高さを決める指定を持つため対応ブラウザでは効かず、行数だけを
    // 固定すると「無効化された属性」を守って高さそのものを放置することになる。両方を要求する。
    expect(extras, '面の側の最小高さが失われています（行数だけでは高さは守られません）').toContain(
      'min-h-64',
    );
    expect(
      (textarea as HTMLTextAreaElement).rows,
      '行数の控えが失われています（内容依存の高さに対応しないブラウザ向け）',
    ).toBe(10);
    // 高さだけは面の側の判断（生成された下書きの全文が一目で読める高さ）。それ以外は部品の領分。
    const COMPONENT_OWNED = /^border(?:-|$)|^p[xytrbles]?-|^text-(?:xs|sm|base|lg|[2-9]?xl)$|^w-/;
    expect(
      extras.filter((utility) => COMPONENT_OWNED.test(utility)),
      `面の側が足したユーティリティ: ${extras.join(' ')}`,
    ).toEqual([]);
  });

  it('再生成の押しボタンは輪郭の変種で、押しボタンの寸法区分を面の側で上書きしない（正典 7.10）', () => {
    render(<DraftPanel {...props()} />);
    expectButtonKeepsComponentSizing(
      screen.getByRole('button', { name: /別の文章を生成/ }),
      'outline',
    );

    // 失敗の分岐にも同じ押しボタンがある。片方だけ直す改変を落とすため、両方に同じ検査を当てる。
    cleanup();
    render(<DraftPanel {...props({ generationFailed: true })} />);
    expectButtonKeepsComponentSizing(
      screen.getByRole('button', { name: /もう一度生成/ }),
      'outline',
    );
  });

  it('主操作も同じ押しボタンの寸法区分に従う（正典 7.9 / 7.10）', () => {
    render(<DraftPanel {...props()} />);
    expectButtonKeepsComponentSizing(screen.getByRole('button', { name: /コピー/ }), 'default');
  });

  it('操作できない状態はブラウザ標準の属性で表す（Requirements 3.5）', () => {
    // 焦点の到達を止めてよい操作なので、`disabled` 属性そのもので表す。
    // `aria-disabled` は「焦点が到達し続ける必要がある操作」の手段であり、ここでは使わない。
    for (const over of [{ regenerationsLeft: 0 }, { regenerating: true }]) {
      cleanup();
      render(<DraftPanel {...props(over)} />);
      const button = screen.getByRole('button', { name: /別の文章を生成/ }) as HTMLButtonElement;
      const where = JSON.stringify(over);
      expect(button.hasAttribute('disabled'), `${where}: disabled 属性がありません`).toBe(true);
      expect(button.disabled, `${where}: 無効になっていません`).toBe(true);
      expect(
        button.getAttribute('aria-disabled'),
        `${where}: aria-disabled で表しています`,
      ).toBeNull();
    }

    // 失敗の分岐の再試行は、着手前まで無効化を 1 件も検証されていなかった。
    cleanup();
    render(<DraftPanel {...props({ generationFailed: true, regenerationsLeft: 0 })} />);
    const retry = screen.getByRole('button', { name: /もう一度生成/ }) as HTMLButtonElement;
    expect(retry.hasAttribute('disabled'), '再試行に disabled 属性がありません').toBe(true);
    expect(
      retry.getAttribute('aria-disabled'),
      '再試行を aria-disabled で表しています',
    ).toBeNull();

    cleanup();
    render(<DraftPanel {...props({ generationFailed: true })} />);
    expect(
      (screen.getByRole('button', { name: /もう一度生成/ }) as HTMLButtonElement).disabled,
      '残数があるのに再試行が無効です',
    ).toBe(false);
  });

  it('投稿導線の見た目は押しボタンの算出結果と相等する（正典 7.9 / 7.10）', () => {
    // 手書きの文字列で固定すると、部品の側が変わったときに古びたまま緑になる。
    const expected = cn(buttonVariants({ variant: 'outline', size: 'lg', className: 'w-full' }));
    expect(expected, '期待値を算出できていません').not.toBe('');

    for (const branch of [
      { label: '生成成功', over: {} },
      { label: '生成失敗', over: { generationFailed: true } },
    ]) {
      cleanup();
      render(<DraftPanel {...props(branch.over)} />);
      const links = screen.getAllByRole('link', { name: /クチコミを書く/ });
      expect(links, `${branch.label}: 投稿導線の個数が 1 つではありません`).toHaveLength(1);
      const link = links[0]!;
      expect(link.getAttribute('class'), `${branch.label}: 投稿導線の見た目`).toBe(expected);
      // 意匠の適用で落ちやすい属性（着手前は href だけが検証されていた）。
      expect(link.getAttribute('href'), `${branch.label}: href`).toBe(URL);
      expect(link.getAttribute('target'), `${branch.label}: target`).toBe('_blank');
      expect(link.getAttribute('rel'), `${branch.label}: rel`).toBe('noopener noreferrer');
    }
  });

  it('生成失敗の通知は部品を通り、読み上げ強度が中断のまま', () => {
    render(<DraftPanel {...props({ generationFailed: true })} />);
    const alerts = screen.queryAllByRole('alert');
    expect(alerts, '危険の通知の個数が 1 つではありません').toHaveLength(1);
    const alert = alerts[0]!;
    expect(alert.getAttribute('data-slot'), '通知が部品を通っていません').toBe('alert');
    expect(
      alert.querySelector('[data-slot="alert-description"]'),
      '通知の説明文が部品を通っていません',
    ).not.toBeNull();
    // 相等で固定する。包含だと文言の後付けが素通りし、読み上げられる名前を変えないという
    // 要求（Requirements 3.2）を守れない。
    expect(alert.textContent).toBe(FAILED);
  });

  it('操作要素とリンクの個数は分岐ごとに固定されている（Requirements 3.3）', () => {
    render(<DraftPanel {...props()} />);
    expect(screen.getAllByRole('button'), '生成成功の押しボタンの個数').toHaveLength(2);
    expect(screen.getAllByRole('link'), '生成成功のリンクの個数').toHaveLength(1);

    cleanup();
    render(<DraftPanel {...props({ generationFailed: true })} />);
    expect(screen.getAllByRole('button'), '生成失敗の押しボタンの個数').toHaveLength(1);
    expect(screen.getAllByRole('link'), '生成失敗のリンクの個数').toHaveLength(1);
  });
});

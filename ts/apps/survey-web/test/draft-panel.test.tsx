// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Alert } from '@fwlm/ui/components/alert';
import { buttonVariants } from '@fwlm/ui/components/button';
import { cn } from '@fwlm/ui/lib/utils';
import { Textarea } from '@fwlm/ui/components/textarea';
import { DraftPanel } from '../src/app/s/[storeId]/draft-panel';
import type { DraftPanelProps } from '../src/app/s/[storeId]/types';
import { announcedText, ownText } from './live-region';

const URL = 'https://search.google.com/local/writereview?placeid=ChIJ';
/** 再生成中の押しボタンの文言（三点リーダは U+2026）。 */
const REGENERATING_BUTTON = '別の文章を作成しています…';

function props(over: Partial<DraftPanelProps> = {}): DraftPanelProps {
  return {
    draft: '良いお店でした。',
    generationFailed: false,
    regenerationsLeft: 3,
    googleReviewUrl: URL,
    onRegenerate: vi.fn(),
    onReviewLinkOpen: vi.fn(),
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

  it('生成中は押しボタン自身が「別の文章を作成しています…」に変わり、無効・処理中になる（3.6）', () => {
    render(<DraftPanel {...props({ regenerating: true })} />);
    const button = screen.getByRole('button', { name: REGENERATING_BUTTON }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    // 図形は押しボタンの中で装飾として回る（状態は文言で伝える）。
    expect(button.querySelector('[data-slot="spinner"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText(GENERATING)).toBeDefined();
    expect(screen.queryByRole('button', { name: /別の文章を生成/ })).toBeNull();
  });

  it('生成失敗の再試行も、生成中は「別の文章を作成しています…」に変わり無効になる', () => {
    render(<DraftPanel {...props({ generationFailed: true, regenerating: true })} />);
    const button = screen.getByRole('button', { name: REGENERATING_BUTTON }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('生成中でないときの押しボタンは処理中ではない', () => {
    render(<DraftPanel {...props()} />);
    const button = screen.getByRole('button', { name: /別の文章を生成（残り3回）/ });
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it('生成失敗時は失敗メッセージ＋再試行＋投稿導線を表示する（3.9）', () => {
    render(<DraftPanel {...props({ generationFailed: true })} />);
    expect(screen.getByText(/下書きの生成に失敗/).textContent).toContain('失敗');
    expect(screen.getByRole('button', { name: /もう一度生成/ })).toBeDefined();
    expect(screen.getByRole('link', { name: /クチコミ欄を開く/ }).getAttribute('href')).toBe(URL);
  });

  it('投稿導線は全状態で表示され star 分岐が無い（4.4・ゲーティング不在）', () => {
    const { rerender } = render(<DraftPanel {...props()} />);
    expect(screen.getByRole('link', { name: /クチコミ欄を開く/ }).getAttribute('href')).toBe(URL);
    rerender(<DraftPanel {...props({ generationFailed: true })} />);
    expect(screen.getByRole('link', { name: /クチコミ欄を開く/ }).getAttribute('href')).toBe(URL);
  });

  it('draft prop 変更（再生成到着）で textarea が更新される', () => {
    const { rerender } = render(<DraftPanel {...props({ draft: '最初' })} />);
    expect((screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement).value).toBe('最初');
    rerender(<DraftPanel {...props({ draft: '再生成後' })} />);
    expect((screen.getByLabelText('口コミ下書き') as HTMLTextAreaElement).value).toBe('再生成後');
  });

  // Issue #137・Requirement 5.8: 押下を観測する通知は遷移と独立。パネルはシェルへ知らせるだけで、
  // リンクそのもの（writereview への直リンク・既定の遷移）は変えない。
  it('投稿導線を押すと onReviewLinkOpen を 1 回呼び、既定の遷移を止めない（成功・失敗の両状態）', () => {
    for (const generationFailed of [false, true]) {
      const onReviewLinkOpen = vi.fn();
      render(<DraftPanel {...props({ generationFailed, onReviewLinkOpen })} />);
      const link = screen.getByRole('link', { name: /クチコミ欄を開く/ });

      // fireEvent.click は preventDefault されると false を返す
      expect(fireEvent.click(link)).toBe(true);
      expect(onReviewLinkOpen).toHaveBeenCalledTimes(1);
      expect(link.getAttribute('href')).toBe(URL);
      expect(link.getAttribute('target')).toBe('_blank');
      cleanup();
    }
  });
});

// ---- ここから ui-airbnb-surfaces task 4.2 が追加した検証 ----

/** 生成中に読み上げ領域へ出す補足。処理中の図形と「作成しています…」は押しボタンの側が持つ。 */
const GENERATING = '回答内容をもとに文章を作成しています';
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
  if (children.length === 0) return document.querySelector('[data-slot="alert"]');
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
    expect(screen.queryAllByRole('alert'), '結果の読み上げは Toast が担う').toHaveLength(0);
  });

  it('コピー後に再生成しても読み上げ領域は 1 つのまま（生成中が勝つ）', async () => {
    const { rerender } = render(<DraftPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    expect(await screen.findByText(/コピーしました/)).toBeDefined();
    expect(announcedText(theLiveRegion()), 'コピー直後の読み上げ文字列').toBe('');

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

  it('処理中の図形は押しボタンに装飾として添えられ、読み上げ領域には入らない（aria-hidden）', () => {
    render(<DraftPanel {...props({ regenerating: true })} />);
    expect(theLiveRegion().querySelector('[data-slot="spinner"]'), '図形が読み上げ領域の中で二重に回っています').toBeNull();
    const spinner = screen.getByRole('button', { name: REGENERATING_BUTTON }).querySelector('[data-slot="spinner"]');
    // **否定の前に非空アンカーを置く。** 図形を掴めていないと下の判定は空振りする。
    expect(spinner, '処理中の図形を掴めていません').not.toBeNull();
    expect(
      spinner!.getAttribute('aria-hidden'),
      '図形が読み上げ領域として二重に数えられます',
    ).toBe('true');

    cleanup();
    render(<DraftPanel {...props()} />);
    expect(
      document.querySelector('[data-slot="spinner"]'),
      '生成中でないのに処理中の図形が描かれています',
    ).toBeNull();
  });

  it('コピー結果は画面内の読み上げ領域に重ねない（Toast が通知する）', async () => {
    render(<DraftPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    expect(await screen.findByText(/コピーしました/)).toBeDefined();
    expect(announcedText(theLiveRegion()), '自動コピー成功時の読み上げ文字列').toBe('');

    cleanup();
    vi.stubGlobal('navigator', {});
    render(<DraftPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /コピー/ }));
    expect(announcedText(theLiveRegion()), '手動コピー案内時の読み上げ文字列').toBe('');
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
      const button = screen.getByRole('button', {
        name: 'regenerating' in over ? REGENERATING_BUTTON : /別の文章を生成/,
      }) as HTMLButtonElement;
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
      const links = screen.getAllByRole('link', { name: /クチコミ欄を開く/ });
      expect(links, `${branch.label}: 投稿導線の個数が 1 つではありません`).toHaveLength(1);
      const link = links[0]!;
      expect(link.getAttribute('class'), `${branch.label}: 投稿導線の見た目`).toBe(expected);
      // 意匠の適用で落ちやすい属性（着手前は href だけが検証されていた）。
      expect(link.getAttribute('href'), `${branch.label}: href`).toBe(URL);
      expect(link.getAttribute('target'), `${branch.label}: target`).toBe('_blank');
      expect(link.getAttribute('rel'), `${branch.label}: rel`).toBe('noopener noreferrer');
    }
  });

  it('生成失敗の案内は部品を通り、Toastと二重に読み上げない', () => {
    render(<DraftPanel {...props({ generationFailed: true })} />);
    const alerts = document.querySelectorAll<HTMLElement>('[data-slot="alert"]');
    expect(alerts, '危険の案内の個数が 1 つではありません').toHaveLength(1);
    expect(alerts[0]!.getAttribute('role')).toBeNull();
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

// ---- ここから Issue #179 が追加した検証（下書きの由来と推敲の促し） ----

/**
 * 下書きの近傍に置く説明。**「AI」の語は出さない。**
 *
 * Google の 2026-04 改定を一次情報で確認したところ、日英いずれの原文にも AI・自動生成への
 * 言及は無い。禁止の実体は「実体験に基づいていないコンテンツ」であり、それを担保する主体は
 * システムではなく客本人である。したがって伝えるべきは生成技術の名前ではなく、
 * **素材が客自身の回答であること**と、**投稿するのは客自身の言葉であること**の 2 つになる。
 */
const PROVENANCE = 'あなたの回答をもとに作成した下書きです。';
const REVISION_PROMPT = 'ご自身の言葉に直してから投稿してください。';

describe('下書きパネル: 由来の明示と推敲の促し（Issue #179）', () => {
  it('下書きの由来と、自分の言葉へ直す促しを 1 つの段落として表示する', () => {
    render(<DraftPanel {...props()} />);
    // getByText は不在なら例外を投げるので、取得できたこと自体は assert にならない。
    // **2 文が同じ段落に載っていること**まで見る（別々の要素へ割ると aria-describedby が
    // 片方しか指せず、由来だけ、あるいは促しだけが読み上げられる形になる）。
    const note = screen.getByText(
      (_, element) => {
        const text = element?.textContent ?? '';
        return text.includes(PROVENANCE) && text.includes(REVISION_PROMPT);
      },
      { selector: 'p' },
    );
    expect(note.textContent?.trim()).toBe(`${PROVENANCE}${REVISION_PROMPT}`);
  });

  it('その説明は読み上げ領域の外にある（既存の a11y と競合しない）', () => {
    render(<DraftPanel {...props()} />);
    const region = theLiveRegion();
    // 既存の読み上げ領域は差し替え型で、言うことが無いときは空のまま常時マウントされる。
    // 静的な説明をそこへ入れると、通知のたびに説明ごと読み上げ直される。
    expect(
      announcedText(region),
      '静的な説明が読み上げ領域の中にあります（通知のたびに読み上げ直されます）',
    ).not.toContain(PROVENANCE);
    // 領域の個数そのものは theLiveRegion() が 1 つに固定している。説明へ役割や aria-live を
    // 付けるとそこで落ちるため、この面の読み上げ領域は増えない。
  });

  it('下書きの入力欄がその説明を説明として指している（aria-describedby）', () => {
    render(<DraftPanel {...props()} />);
    const textarea = screen.getByLabelText('口コミ下書き');
    const describedBy = textarea.getAttribute('aria-describedby');
    expect(describedBy, '入力欄が説明を指していません').not.toBeNull();
    const note = document.getElementById(describedBy!);
    expect(note, `aria-describedby=${String(describedBy)} の指す要素がありません`).not.toBeNull();
    expect(note!.textContent).toContain(PROVENANCE);
    expect(note!.textContent).toContain(REVISION_PROMPT);
  });

  it('生成に失敗した分岐では出さない（下書きが存在しないため）', () => {
    render(<DraftPanel {...props({ generationFailed: true })} />);
    // 条件つきの形だけを assert すると「無条件に出す」改変が素通りする。既定側を固定する。
    expect(screen.queryByText(new RegExp(PROVENANCE))).toBeNull();
    expect(screen.queryByText(new RegExp(REVISION_PROMPT))).toBeNull();
  });
});

// 「説明を足しても操作要素とリンクの個数が変わらない」ことは、上の
// 「操作要素とリンクの個数は分岐ごとに固定されている（Requirements 3.3）」が既に押しボタン 2 件・
// リンク 1 件で固定している。同じことを 2 箇所で見る層は、片方が腐ったときに腐ったと言えない。

// ---- ここから「文章をコピー」と「Google のクチコミ欄を開く」を順に並べる変更が追加した検証 ----
//
// 着手前は主ボタンの文言が「コピーして投稿する」で、押してもコピーしかしなかった。投稿画面への
// リンクは再生成と通知の後ろ、パネルの最下部にあった。Requirement 4.1 の導線は、客が順に行う
// 2 つの操作（コピー → 投稿画面を開く）として 1 つの導線を成す。自動遷移はしない。

const COPY_BUTTON = '文章をコピー';
const REVIEW_LINK = 'Google のクチコミ欄を開く';
/** コピー成功後の画面内の案内。次に押すリンクを名前で指す。 */
const COPIED = 'コピーしました。「Google のクチコミ欄を開く」から投稿画面を開き、本文欄に貼り付けてください。';
const MANUAL = '自動コピーできませんでした。上の文章を選択して手動でコピーしたあと、「Google のクチコミ欄を開く」から投稿画面を開けます。';

function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('下書きパネル: コピーと投稿画面を開く操作を順に並べる（Requirement 4.1）', () => {
  it('推敲の案内 → 文章をコピー → Google のクチコミ欄を開く → 再生成 の順に描く', () => {
    render(<DraftPanel {...props()} />);
    const note = screen.getByText(
      (_, element) => element?.tagName === 'P' && (element.textContent ?? '').includes(REVISION_PROMPT),
    );
    const copy = screen.getByRole('button', { name: COPY_BUTTON });
    const link = screen.getByRole('link', { name: REVIEW_LINK });
    const regenerate = screen.getByRole('button', { name: /別の文章を生成/ });
    expect(precedes(note, copy), '推敲の案内がコピーより後にあります（4.7）').toBe(true);
    expect(precedes(copy, link), '投稿画面を開くリンクがコピーより前にあります').toBe(true);
    expect(precedes(link, regenerate), '再生成が投稿画面を開くリンクより前にあります').toBe(true);
  });

  it('主ボタンはコピーだけを名乗る（押しても遷移しないため「投稿する」と書かない）', () => {
    render(<DraftPanel {...props()} />);
    expect(screen.getByRole('button', { name: COPY_BUTTON }).textContent).toBe(COPY_BUTTON);
    expect(screen.queryByRole('button', { name: /投稿/ })).toBeNull();
  });

  it('コピー成功後の案内は、次に押すリンクの名前で投稿までの手順を伝える', async () => {
    render(<DraftPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: COPY_BUTTON }));
    const copied = await screen.findByText(COPIED);
    expect(copied.closest('[data-slot="alert"]'), '案内が通知の部品を通っていません').not.toBeNull();
    // 成功しても導線は同じリンクのまま（コピー状態で出し分けない）。
    expect(screen.getAllByRole('link', { name: REVIEW_LINK })).toHaveLength(1);
  });

  it.each([
    ['rejected', () => stubClipboard(vi.fn().mockRejectedValue(new Error('denied')))],
    ['unavailable', () => vi.stubGlobal('navigator', {})],
  ] as const)('コピーに失敗しても（%s）投稿画面を開くリンクは表示され、押せて、案内がそれを指す（4.6）', async (_, arrange) => {
    arrange();
    const onReviewLinkOpen = vi.fn();
    render(<DraftPanel {...props({ onReviewLinkOpen })} />);
    fireEvent.click(screen.getByRole('button', { name: COPY_BUTTON }));
    expect(await screen.findByText(MANUAL)).toBeDefined();

    const link = screen.getByRole('link', { name: REVIEW_LINK });
    expect(link.getAttribute('href')).toBe(URL);
    expect(link.getAttribute('aria-disabled')).toBeNull();
    expect(fireEvent.click(link), 'リンクの既定の遷移が止められています').toBe(true);
    expect(onReviewLinkOpen).toHaveBeenCalledTimes(1);
  });

  it('リンクを押してもコピーはせず、コピーを押しても window.open で遷移しない（自動遷移なし）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<DraftPanel {...props()} />);
    expect(fireEvent.click(screen.getByRole('link', { name: REVIEW_LINK }))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: COPY_BUTTON }));
    await screen.findByText(COPIED);
    expect(open).not.toHaveBeenCalled();
  });
});

// ---- ここから PR #470: コピーの結果の Toast が「Google のクチコミ欄を開く」を覆わないようにする ----
//
// 320×568 の実測では、コピー直後の Toast（上端 460）がリンク（512–560）に 6 秒かぶさり押せなかった。
// Toast の置き場（右下）と表示時間は共通の Toaster のまま変えず、この面が画面を送る。
// jsdom は配置を計算しないので、Sonner 2 の DOM の形と矩形を差し込んで確かめる。実寸の確認は
// E2E（action-feedback.spec.ts）が 3 つの画面の大きさで行う。

function fakeToaster(bottom: number, toastHeight: number): void {
  const ol = document.createElement('ol');
  ol.setAttribute('data-sonner-toaster', 'true');
  ol.setAttribute('data-y-position', 'bottom');
  ol.getBoundingClientRect = () => ({ bottom, top: bottom, left: 0, right: 0, width: 0, height: 0, x: 0, y: bottom, toJSON: () => ({}) });
  const li = document.createElement('li');
  li.setAttribute('data-sonner-toast', '');
  li.dataset.removed = 'false';
  li.dataset.visible = 'true';
  li.style.setProperty('--offset', '0px');
  Object.defineProperty(li, 'offsetHeight', { value: toastHeight });
  ol.append(li);
  document.body.append(ol);
}

function placeActions(bottom: number): void {
  const actions = screen.getByRole('button', { name: COPY_BUTTON }).parentElement!;
  actions.getBoundingClientRect = () => ({ bottom, top: bottom - 168, left: 0, right: 0, width: 0, height: 168, x: 0, y: 0, toJSON: () => ({}) });
}

describe('下書きパネル: コピーの結果の Toast が操作を覆わない（PR #470）', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  });
  afterEach(() => {
    document.querySelectorAll('[data-sonner-toaster]').forEach((el) => el.remove());
  });

  it.each([
    ['成功', () => stubClipboard(vi.fn().mockResolvedValue(undefined))],
    ['失敗', () => stubClipboard(vi.fn().mockRejectedValue(new Error('denied')))],
  ] as const)('コピー%sの Toast が操作の並びに重なるなら、並びが Toast の上に来るまで画面を送り、送る余地を足す', async (_, arrange) => {
    arrange();
    const scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    render(<DraftPanel {...props()} />);
    placeActions(620);
    fakeToaster(552, 92); // 落ち着いた上端は 460
    fireEvent.click(screen.getByRole('button', { name: COPY_BUTTON }));

    const lift = 620 + 12 - 460;
    await waitFor(() => expect(scrollBy).toHaveBeenCalledWith({ top: lift, behavior: 'smooth' }));
    expect(scrollBy).toHaveBeenCalledTimes(1);
    const room = document.querySelector<HTMLElement>('[data-slot="toast-room"]');
    expect(room, '送る余地が足されていません').not.toBeNull();
    expect(room!.style.height).toBe(`${lift}px`);
    expect(room!.getAttribute('aria-hidden')).toBe('true');
    // 導線そのものは変えない（出し分けない・同じリンク）。
    expect(screen.getAllByRole('link', { name: REVIEW_LINK })).toHaveLength(1);
  });

  it('重ならないとき（広い画面）は画面を送らず、余地も足さない', async () => {
    const scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    render(<DraftPanel {...props()} />);
    placeActions(620);
    fakeToaster(828, 73); // 390×844 の実測: 上端 755
    fireEvent.click(screen.getByRole('button', { name: COPY_BUTTON }));
    await screen.findByText(COPIED);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollBy).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="toast-room"]')).toBeNull();
  });

  it('動きを減らす設定では、滑らかに送らずに一度で送る', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }));
    const scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    render(<DraftPanel {...props()} />);
    placeActions(620);
    fakeToaster(552, 92);
    fireEvent.click(screen.getByRole('button', { name: COPY_BUTTON }));
    await waitFor(() => expect(scrollBy).toHaveBeenCalledWith({ top: 172, behavior: 'auto' }));
  });
});

// Web 意味役割カラーペアの WCAG AA コントラスト機械検証（Requirements 5.2 /
// design.md Testing Strategy Unit 1「colors.test.ts」）。
// - WCAG 2.1 の相対輝度とコントラスト比の定義を依存ゼロで自前実装し、Web 面のテキスト
//   前景/背景ペア全てが通常文字の AA 基準（4.5:1 以上）を満たすことを数値で assert する。
// - 対象外: brand・border・borderInteractive（装飾・非テキスト用途）と
//   lineColors（LINE Flex Message は Web コンテンツではないため AA 検証対象外）。
// - primary の具体 hex はこのテストを通ることをもって確定値とする。
import { describe, it, expect } from 'vitest';
import { colors, compositeOver, contrastRatio, hexToRgb, relativeLuminance } from '../src/index.js';

/** 通常文字の WCAG 2.1 AA 基準（Requirements 5.2）。 */
const AA_NORMAL_TEXT_RATIO = 4.5;

/** 非テキスト（部品の境界・状態の指標）の WCAG 2.1 AA 基準（SC 1.4.11）。 */
const AA_NON_TEXT_RATIO = 3;

/** Web 面でテキスト描画に使う前景/背景の全ペア（意味役割名で列挙）。 */
const AA_TEXT_PAIRS: ReadonlyArray<{
  foreground: keyof typeof colors;
  background: keyof typeof colors;
}> = [
  { foreground: 'text', background: 'background' },
  { foreground: 'textBody', background: 'background' },
  { foreground: 'textMuted', background: 'background' },
  { foreground: 'primaryForeground', background: 'primary' },
  // hover 状態のテキストも WCAG 1.4.3 の対象。通常時に AA を満たしていても hover で割る事故
  // （Issue #50 の bg-primary/80）を再発させないため、hover 面も同じ基準で検証する。
  { foreground: 'primaryForeground', background: 'primaryHover' },
  { foreground: 'destructiveForeground', background: 'destructive' },
  { foreground: 'success', background: 'background' },
  // 中立の面は「その上に文字が載る面」である。面そのものを非テキスト扱いにすると、
  // 面を暗くしたときに上の文字が AA を割っても気づけない。面の役割はここで前景と対にして固定する。
  { foreground: 'text', background: 'surfaceStrong' },
  { foreground: 'textMuted', background: 'surfaceSoft' },
];

/** AA 検証の対象外とする意味役割（装飾・面塗り・非テキスト用途）。 */
const NON_TEXT_ROLES: readonly (keyof typeof colors)[] = [
  'brand',
  'border',
  // 識別用の枠色。テキスト前景としては使わないため AA_TEXT_PAIRS には入れない。
  // SC 1.4.11 の 3:1 は「隣接する背景」との関係で決まるが、トークン単体は何に隣接するかを
  // 知らないため、比の assert は使用箇所側のガード（ui/test/contrast-usage.test.ts）が担う。
  // ここで 3:1 を二重に主張すると、片方の変更が他方へ伝わらない二重管理になる（design.md D7）。
  'borderInteractive',
];

describe('コントラスト計算ヘルパ（既知値による自己検証）', () => {
  it('黒/白は 21:1・同色は 1:1 を返す', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('前景/背景の順序に依存しない（対称）', () => {
    expect(contrastRatio('#333333', '#FFFFFF')).toBe(
      contrastRatio('#FFFFFF', '#333333'),
    );
  });

  it('ブランド色 #FF385C と白は約 3.52:1（AA 非準拠の既知値）と計算される', () => {
    // この自己検証はリテラル引数なので、トークンを差し替えても緑のまま通ってしまう。
    // 現行のブランド色を書いておかないと「非準拠を記録している」という主張だけが残り、
    // 中身が別の色の話になる（意匠差し替え時に実際そうなりかけた）。
    expect(contrastRatio('#FF385C', '#FFFFFF')).toBeCloseTo(3.52, 2);
  });

  it('アクション色 #E00B41 と白は約 4.89:1（AA 準拠の下限に近い既知値）と計算される', () => {
    // 上の非準拠色とこの準拠色の差が、装飾用とアクション用を分ける根拠そのものである。
    expect(contrastRatio('#E00B41', '#FFFFFF')).toBeCloseTo(4.89, 2);
  });
});

describe('アルファ合成ヘルパ compositeOver（既知値による自己検証・Issue #50）', () => {
  it('alpha=1 は前景そのもの・alpha=0 は背景そのものを返す', () => {
    expect(compositeOver('#15803D', '#FFFFFF', 1)).toBe('#15803D');
    expect(compositeOver('#15803D', '#FFFFFF', 0)).toBe('#FFFFFF');
  });

  it('黒を白に 50% 合成すると中間灰になる', () => {
    expect(compositeOver('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });

  it('6桁大文字 hex を返す（contrastRatio へそのまま渡せる形式）', () => {
    expect(compositeOver('#DC2626', '#FFFFFF', 0.1)).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('alpha=1 の合成結果は元の色とコントラスト比が一致する（既存ヘルパとの接続確認）', () => {
    expect(contrastRatio(compositeOver('#333333', '#FFFFFF', 1), '#FFFFFF')).toBe(
      contrastRatio('#333333', '#FFFFFF'),
    );
  });

  it('0..1 の範囲外の alpha は拒否する', () => {
    expect(() => compositeOver('#000000', '#FFFFFF', 1.5)).toThrow();
    expect(() => compositeOver('#000000', '#FFFFFF', -0.1)).toThrow();
  });
});

describe('colors（Web 意味役割）の WCAG AA コントラスト（Requirements 5.2）', () => {
  for (const pair of AA_TEXT_PAIRS) {
    it(`${pair.foreground} / ${pair.background} は ${AA_NORMAL_TEXT_RATIO}:1 以上`, () => {
      const ratio = contrastRatio(colors[pair.foreground], colors[pair.background]);
      expect(
        ratio,
        `${pair.foreground}(${colors[pair.foreground]}) on ` +
          `${pair.background}(${colors[pair.background]}) → ${ratio.toFixed(3)}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_RATIO);
    });
  }

  it('全ての意味役割が AA 検証ペアか対象外リストのいずれかに分類されている', () => {
    // 新しい色役割を追加したら、テキスト用途なら AA_TEXT_PAIRS へ、
    // 装飾・非テキスト用途なら NON_TEXT_ROLES へ必ず分類させるための網羅ガード。
    const classified = new Set<string>(NON_TEXT_ROLES);
    for (const pair of AA_TEXT_PAIRS) {
      classified.add(pair.foreground);
      classified.add(pair.background);
    }
    expect([...classified].sort()).toEqual(Object.keys(colors).sort());
  });
});

// 識別用（フォーム入力部品・対話的部品の輪郭）と装飾用（区切り線・カード罫線・情報コンテナ
// 外枠）の枠色は別の意味役割である。両者が同値に潰れていると、識別用だけを濃くすることが
// 構造的に不可能になる（本 spec 以前の実態: --input が装飾用の枠色を参照していた）。
// 値の分離をここで不変条件として固定し、将来「片方に合わせて」統合されることを防ぐ
// （design.md「色役割定義」State Management の不変条件 / Testing Strategy Unit 1）。
describe('枠色の意味役割分離の不変条件（Requirements 4.1, 6.1）', () => {
  it('識別用の枠色役割が値の単一情報源に存在する', () => {
    expect(
      colors.borderInteractive,
      'colors.borderInteractive が未定義です（識別用の枠色役割が単一情報源にありません）',
    ).toBeDefined();
  });

  it('識別用の枠色は装飾用の枠色と異なる値を持つ', () => {
    expect(
      colors.borderInteractive,
      `識別用と装飾用が同値です（borderInteractive: ${colors.borderInteractive} / ` +
        `border: ${colors.border}）。同値では識別用だけを濃くできません。`,
    ).not.toBe(colors.border);
  });
});


// hover は「暗くする」方向で表現する規約（Issue #50）。
//
// この規約はこれまでコメントにしか存在しなかった。アルファ合成（bg-primary/80 等）で hover を
// 表すと、白背景では合成後が**明るくなり**、通常時に AA を満たしていても hover でだけ割る。
// 実際に primary の hover が 5.02:1 から 3.49:1 へ落ちていた。
//
// コントラストのペア検証だけではこれを守れない。hover 面と前景のペアは AA_TEXT_PAIRS に
// 入っているが、「静止時より明るい hover」でも比が 4.5 を超えていれば緑になるためである。
// 向きそのものを不変条件として固定する。
describe('hover の向きの不変条件（Issue #50 / Requirements 1.3）', () => {
  it('primaryHover は primary より暗い（相対輝度が小さい）', () => {
    const still = relativeLuminance(colors.primary);
    const hovered = relativeLuminance(colors.primaryHover);
    expect(
      hovered,
      `primaryHover(${colors.primaryHover} / 輝度 ${hovered.toFixed(5)}) が ` +
        `primary(${colors.primary} / 輝度 ${still.toFixed(5)}) より明るくなっています。` +
        'hover は暗くする方向で表現すること（明るくすると白文字とのコントラストが落ちる）。',
    ).toBeLessThan(still);
  });
});

// 成功と危険の識別（Requirements 2.1, 2.2）。
//
// **輝度比ではこの事故を検出できない。** 成功色がアクション色を共有していると、アクション色を
// 暖色系へ差し替えた瞬間に成功通知が危険通知と同系色になるが、色相の変化は輝度を変えないため、
// 本ファイルの AA ペア検証も ui 側のコントラスト検証も緑のまま通る。
//
// 赤成分と緑成分の大小は色相そのものではなく**代理指標**である。ここで固定したいのは
// 「成功と危険が別の側にある」ことだけであり、厳密な色相角を要求するとパレットの自由度を
// 不必要に縛るため、この粒度を採る。
describe('成功と危険の識別（Requirements 2.1, 2.2）', () => {
  const side = (hex: string): 'warm' | 'cool' => {
    const [red, green] = hexToRgb(hex);
    return red > green ? 'warm' : 'cool';
  };

  it('成功色は緑寄り、危険色は赤寄りで、互いに別の側にある', () => {
    expect(side(colors.success), `success(${colors.success}) が赤寄りです`).toBe('cool');
    expect(side(colors.destructive), `destructive(${colors.destructive}) が緑寄りです`).toBe('warm');
    expect(
      side(colors.success),
      '成功色と危険色が同じ側にあります。色で区別できない状態です。',
    ).not.toBe(side(colors.destructive));
  });

  // アクション色と危険色は、この意匠では**色では区別できない**。
  //
  // 出典のパレットは暖色一色（brand / primary / destructive がすべて赤系）であり、
  // アクション色 #E00B41 と危険色 #B32505 は色相が約 14 度、相互コントラストが 1.35:1 しかない。
  // 差し替え前の緑と赤の組も相互比は 1.29:1 だったので、**両者を分けていたのは輝度ではなく色相**
  // であり、その色相差が失われた。成功色に入れた分離の不変条件はここへは適用できない
  // （危険色を暖色から外すと「危険」に読まれなくなる）。
  //
  // したがってこの組は「色では区別できない」ことを受け入れ、区別は色以外の手掛かりが担う。
  // 手掛かりの実効性は @fwlm/ui の test/contrast-usage.test.ts
  //「選択済みの面をアクション色で塗る部品のエラー指標」が数値で検証する。
  // 本テストはその判定が前提にしている状態を固定する。**前提が変われば向こうも見直しが要る。**
  it('アクション色は暖色側にあり、危険色と色では区別できない（受容した前提の固定）', () => {
    // tasks.md 2.3 が要求していた「アクション色・危険色は成功色の逆側」の固定でもある。
    expect(side(colors.primary), `primary(${colors.primary}) が寒色側にあります`).toBe('warm');
    const ratio = contrastRatio(colors.primary, colors.destructive);
    expect(
      ratio,
      `primary(${colors.primary}) と destructive(${colors.destructive}) の相互比が ` +
        `${ratio.toFixed(2)}:1 になり、色だけで区別できるようになりました。` +
        '@fwlm/ui 側で「色以外の手掛かり」を要求している判定が過剰になっていないか見直すこと。',
    ).toBeLessThan(AA_NON_TEXT_RATIO);
  });

  it('成功色はアクション色・ブランド色・危険色のいずれとも値を共有しない', () => {
    for (const [name, value] of [
      ['primary', colors.primary],
      ['brand', colors.brand],
      ['destructive', colors.destructive],
    ] as const) {
      expect(
        colors.success,
        `success が ${name} と同値です。${name} を差し替えると成功通知の色が巻き込まれます。`,
      ).not.toBe(value);
    }
  });
});

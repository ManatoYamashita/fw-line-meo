// 部品が実際に使う「アルファ合成後の実効色」の WCAG コントラスト検証（Issue #50 / Requirements 5.2）。
//
// なぜこのテストが要るか:
// design-tokens/test/colors.test.ts は「トークン素の値のペア」しか検証しない。しかし
// `text-success/90` や `bg-destructive/10` のような不透明度付きユーティリティは、ブラウザ上では
// 「その色を下地に合成した色」として描画されるため、コントラスト比は合成後の実効色で決まる。
// 実際に PR #46/#47 では 5 箇所が AA を割ったまま CI 全緑で main に入った。
// design-tokens が「ブランド色は対白 3.52:1 だから文字色に使わない」と明記しているにもかかわらず、
// `/90` や `/80` の合成が同じ失敗を再導入していた、という構図である。
//
// 本テストは 4 層で構成する:
//   1. 数値検証 — USAGE_PAIRS の各エントリについて合成後の実効色を求め、しきい値以上を assert
//   2. 網羅ガード — 部品ソースを走査して色ユーティリティを**不透明度の有無に関わらず**全抽出し、
//      USAGE_PAIRS ∪ EXEMPT_UTILITIES と双方向で突き合わせる（Requirements 5.1）。#48 で潰した
//      「集合包含だけでは不十分」と同じ穴を空けないため、「部品に新しい色指定を足したのに
//      検証表へ追記し忘れた」を必ず赤化させる。
//   3. 子孫指定の色ガード — 親 variant が子へ渡す色（`*:data-[slot=…]:text-…`）を独立に抽出して
//      検証する。子が自前の色を持つ場合、この指定が消えると状態色は画面に出ないのに
//      クラス名の集合は何も壊れず、1・2 は緑のまま通る（PR #56 レビュー指摘1）。
//   4. color-mix ガード — 静的計算できない色指定を、出現箇所（file + 式）単位で許可リストと
//      突き合わせ、実ブラウザで実測した実効色の登録を強制する（PR #56 レビュー指摘2）。
//
// 意味論名 → 実 hex の解決は theme.css の宣言から導出する（手書きの対応表を持たない）。
// 対応表を手写しすると、それ自体が新たな同期漏れの発生源になるため。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { compositeOver, contrastRatio } from '@fwlm/design-tokens';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const componentsDir = join(srcDir, 'components');
const themeCss = readFileSync(join(srcDir, 'theme.css'), 'utf8');

/** 通常文字の WCAG 2.1 AA 基準（Requirements 5.2）。 */
const AA_NORMAL_TEXT_RATIO = 4.5;
/** 非テキスト（UI 部品の境界・状態表示）の WCAG 2.1 SC 1.4.11 基準。 */
const AA_NON_TEXT_RATIO = 3;

// --- 意味論名の解決 -----------------------------------------------------------------

/**
 * theme.css の全 `--name: <値>;` 宣言を集める（@theme / :root / @theme inline を区別しない）。
 * 同名が複数回宣言されることは設計上無い（theme.css:99-102 が循環参照防止のため再定義を禁じている）。
 */
function collectDeclarations(css: string): ReadonlyMap<string, string> {
  const declarations = new Map<string, string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1]!;
    if (!declarations.has(name)) {
      declarations.set(name, match[2]!.trim());
    }
  }
  return declarations;
}

describe('collectDeclarations の自己検証（Issue #60）', () => {
  it('先頭と末尾の宣言を漏らさず、値の空白を落とす', () => {
    const map = collectDeclarations('--a: #111;\n  --b:   #222  ;\n--c:#333;');
    expect([...map.entries()]).toEqual([
      ['--a', '#111'],
      ['--b', '#222'],
      ['--c', '#333'],
    ]);
  });

  it('同名の再宣言は最初の宣言を採る（実装コメントの主張の固定）', () => {
    // theme.css は再定義を禁じている（循環参照防止）。その前提が崩れたときにどう振る舞うかを
    // 固定しておかないと、後勝ちへ変わっても誰も気づけない。
    expect(collectDeclarations('--a: #111;\n--a: #222;').get('--a')).toBe('#111');
  });

  it('カスタムプロパティでない宣言は拾わない', () => {
    const map = collectDeclarations('color: red;\n--a: #111;');
    expect([...map.keys()]).toEqual(['--a']);
  });

  it('値の中の var() 参照を宣言として拾わない', () => {
    // `--x: var(--a);` の `--a` は値の一部であって宣言ではない。ここを拾うと、
    // 参照鎖の解決（resolveSemanticColor）が存在しない宣言を見つけて静かに別の色を返す。
    const map = collectDeclarations('--x: color-mix(in oklab, var(--a) 50%, transparent);');
    expect([...map.keys()]).toEqual(['--x']);
  });

  it('メディア条件を宣言と取り違えない', () => {
    // `(prefers-reduced-motion: reduce)` は「プロパティ: 値」の形をしている（PR #59 で踏んだ型）。
    const map = collectDeclarations('@media (prefers-reduced-motion: reduce) { --a: #111; }');
    expect([...map.keys()]).toEqual(['--a']);
  });
});

const declarations = collectDeclarations(themeCss);

/**
 * Tailwind の色ユーティリティ名（`primary` / `muted-foreground` 等）を実 hex へ解決する。
 * `--color-<name>` を起点に `var(--other)` の参照鎖をたどる。
 */
function resolveSemanticColor(name: string, seen: readonly string[] = []): string {
  const variable = seen.length === 0 ? `--color-${name}` : name;
  if (seen.includes(variable)) {
    throw new Error(`CSS 変数の参照が循環しています: ${[...seen, variable].join(' -> ')}`);
  }
  const value = declarations.get(variable);
  if (value === undefined) {
    throw new Error(`theme.css に ${variable} の宣言がありません（意味論名: ${name}）`);
  }
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    return value.toUpperCase();
  }
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (reference === null) {
    throw new Error(`${variable} の値を hex へ解決できません: ${value}`);
  }
  return resolveSemanticColor(reference[1]!, [...seen, variable]);
}

describe('意味論名の hex 解決（theme.css からの導出・自己検証）', () => {
  it('@theme に直接ある色をそのまま返す', () => {
    expect(resolveSemanticColor('primary')).toBe('#E00B41');
  });

  it('@theme inline → :root → @theme の参照鎖をたどる', () => {
    // --color-card -> var(--card) -> var(--color-background) -> #FFFFFF
    expect(resolveSemanticColor('card')).toBe('#FFFFFF');
    // --color-success -> @theme の実値（アクション色を経由しなくなった）
    expect(resolveSemanticColor('success')).toBe('#15803D');
    // --color-muted-foreground -> var(--muted-foreground) -> var(--color-text-muted)
    expect(resolveSemanticColor('muted-foreground')).toBe('#6A6A6A');
  });

  it('未定義の意味論名は例外にする（静かな空振りを防ぐ）', () => {
    expect(() => resolveSemanticColor('no-such-color')).toThrow();
  });
});

// --- 検証表 -------------------------------------------------------------------------

interface UsagePair {
  /** 部品ソースに現れる色ユーティリティ（網羅ガードの突き合わせキー）。 */
  readonly utility: string;
  /** 出典（どの部品のどの状態か）。 */
  readonly source: string;
  /** 前景の意味論名。 */
  readonly foreground: string;
  /** 前景の不透明度（既定 1）。 */
  readonly foregroundAlpha?: number;
  /** 下地の意味論名。 */
  readonly surface: string;
  /** 下地の不透明度（既定 1）。 */
  readonly surfaceAlpha?: number;
  /** 下地のさらに下にある不透明色（既定 background）。 */
  readonly backdrop?: string;
  /** テキストか非テキスト（しきい値が変わる）。 */
  readonly kind: 'text' | 'non-text';
}

/**
 * 部品が使う色ユーティリティと、その実効コントラストの検証対象ペア。
 *
 * 下地が指定されていない部品（Button ghost / link 等）は親の背景に載るため、
 * 既定の backdrop である `background`（#FFFFFF）を仮定する。
 *
 * **隣接色の選び方**（Requirements 1.3, 5.5 / design.md D7）:
 * コントラストは色単体ではなく**ペアの性質**である。同じユーティリティが複数の部品で
 * 使われている場合、`surface` には**実際に隣り合う相手のうち最も条件の厳しいもの**を取る。
 * 甘い相手（例: 面塗り `bg-muted` に対し `foreground` ではなく実在の `muted-foreground`）を
 * 選ぶと、値が実際には AA を割っていても緑になる空振り検証になる。
 * - 枠線（`border-*`）は「線」であり、識別すべき相手は**隣接する頁背景**であって内側の
 *   面塗りではない（要件 1.1・2.1・4.5）。前景側に色を、`surface` に背景を置く。
 * - 面塗り（`bg-*`）のうち、その面が「頁背景から部品を識別させる」役割を持つものは
 *   非テキストとして頁背景と比べる。その面に載る文字の 4.5:1 は**文字側のエントリ**が担う。
 * - 印・図形（白い丸など）は載る面を明示する。既定の頁背景のままにすると同じ色同士を
 *   比べることになり、実装が正しくても永久に赤くなる。
 */
const USAGE_PAIRS: readonly UsagePair[] = [
  {
    utility: 'bg-destructive/10',
    source: 'button.tsx / badge.tsx variant=destructive（base）',
    foreground: 'destructive',
    surface: 'destructive',
    surfaceAlpha: 0.1,
    kind: 'text',
  },
  {
    utility: 'bg-destructive/20',
    source: 'button.tsx / badge.tsx variant=destructive（hover）',
    foreground: 'destructive',
    surface: 'destructive',
    surfaceAlpha: 0.2,
    kind: 'text',
  },
  {
    utility: 'bg-secondary/80',
    source: 'badge.tsx variant=secondary（<a> 描画時の hover）',
    foreground: 'secondary-foreground',
    surface: 'secondary',
    surfaceAlpha: 0.8,
    kind: 'text',
  },
  {
    // 選択済みの面をアクション色で塗る部品では、**エラーの枠が信号を運べない**。
    // アクション色と危険色は色相が約 14 度しか離れておらず（差し替え前は約 123 度）、
    // 相互コントラストは 1.35:1 しかないためである。これは色相の変化であって輝度の変化ではなく、
    // 面と枠それぞれの対背景比を見るどのガードにも掛からない（両方とも単体では AA を満たす）。
    // したがって残る手掛かりはリングだけになり、リング自身が SC 1.4.11 の 3:1 を満たす必要がある。
    // 隣接色は要素の面色ではなく頁背景である（リングは枠の外側に描かれる）。
    utility: 'ring-destructive/60',
    source: 'checkbox.tsx / radio-group.tsx（aria-invalid・選択済みの面がアクション色で塗られる部品）',
    foreground: 'destructive',
    foregroundAlpha: 0.6,
    surface: 'background',
    kind: 'non-text',
  },
  {
    utility: 'bg-muted/50',
    source: 'card.tsx CardFooter（面塗り。文字は継承）',
    foreground: 'foreground',
    surface: 'muted',
    surfaceAlpha: 0.5,
    kind: 'text',
  },
  {
    utility: 'bg-primary/5',
    source: 'field.tsx FieldLabel（has-data-checked の面塗り。文字は継承）',
    foreground: 'foreground',
    surface: 'primary',
    surfaceAlpha: 0.05,
    kind: 'text',
  },

  // --- 非テキスト（SC 1.4.11・3:1）: 部品の存在と状態を識別させる色使用 ---------------
  // いずれも「利用者が部品を見つけ、状態を読み取る」ための視覚情報であり、装飾ではない
  // （要件 1.1, 1.2, 4.5 / design.md D2, D5, D7）。
  {
    // 識別用の枠色。フォーム入力部品では、フォーカスも選択もしていない状態で部品の存在と
    // 境界を伝える唯一の視覚情報であるため、隣接する頁背景と 3:1 が要る（要件 1.1, 1.2）。
    // Button / Badge の outline は装飾用の枠指定を使っていたが、対話的部品の輪郭は
    // 識別用として扱うという要件 4.5 に従い、この役割へ移した（design.md D2, D5）。
    // Badge は [a] variant を持ちリンクとして描画されうるため、静的な出現があっても
    // 要件 4.4（判断できない場合は識別用に倒す）により同じ扱いとする。
    utility: 'border-input',
    source:
      'input.tsx / textarea.tsx / checkbox.tsx / radio-group.tsx（既定の枠）・' +
      'button.tsx / badge.tsx variant=outline（輪郭の枠）',
    foreground: 'input',
    surface: 'background',
    kind: 'non-text',
  },
  {
    // エラー状態を伝える枠。色以外の手段（可視文言・aria-invalid）と併用されるが、
    // 目で見ている利用者にとっては枠が主要な手がかりであるため 3:1 を掛ける（要件 3.4）。
    utility: 'border-destructive',
    source:
      'input.tsx / textarea.tsx / checkbox.tsx / radio-group.tsx / button.tsx / badge.tsx' +
      '（aria-invalid のエラー枠）',
    foreground: 'destructive',
    surface: 'background',
    kind: 'non-text',
  },
  {
    // 選択済みであることを示す枠。面塗りと印も同時に出るが、いずれも状態表示であり
    // 「選択済みを未選択から区別する」情報を担うため 3:1 を掛ける（要件 2.1）。
    // 識別すべき相手は隣接する頁背景であって、内側の面塗りではない（design.md D3 / 要件 2.1）。
    // FieldLabel の選択枠は不透明度を撤去してこの指定へ合流した。チェックボックス・ラジオと
    // 語彙が一致し、アルファ合成を挟まないぶん検証も単純になる（design.md D3）。
    utility: 'border-primary',
    source:
      'checkbox.tsx / radio-group.tsx（data-checked の選択枠）・' +
      'field.tsx FieldLabel（has-data-checked の選択枠）',
    foreground: 'primary',
    surface: 'background',
    kind: 'non-text',
  },
  {
    // 一つの指定が二つの用途を兼ねる箇所。ここでは「選択済み／既定の状態を頁背景から
    // 識別させる面」として非テキストで登録する。**この面に載る白文字の 4.5:1 は
    // text-primary-foreground のエントリだけが担う**ため、そちらを取り除いてはならない。
    utility: 'bg-primary',
    source:
      'button.tsx / badge.tsx variant=default（面塗り）・' +
      'checkbox.tsx / radio-group.tsx（data-checked の面塗り）',
    foreground: 'primary',
    surface: 'background',
    kind: 'non-text',
  },
  {
    // 選択済みを示す白い印。**選択色の面の上に載る**ため surface に選択色を明示する。
    // 既定の頁背景のままにすると白同士を比べることになり、実装が正しくても永久に赤くなる。
    utility: 'bg-primary-foreground',
    source: 'radio-group.tsx RadioGroupItem の Indicator（選択済みを示す丸い印）',
    foreground: 'primary-foreground',
    surface: 'primary',
    kind: 'non-text',
  },

  // --- テキスト（SC 1.4.3・4.5:1）: 文字色と、文字が載る面塗り -------------------------
  // 面塗り側の surface には「その面に実際に載る前景のうち最も条件の厳しいもの」を取る。
  {
    // 面。載りうる前景のうち最も厳しいのは区切りラベルの弱い文字色。
    utility: 'bg-background',
    source: 'button.tsx variant=outline（面）／ field.tsx FieldSeparator の区切りラベル面',
    foreground: 'muted-foreground',
    surface: 'background',
    kind: 'text',
  },
  {
    // 面。載りうる前景のうち最も厳しいのは Alert variant=success の文字色。
    utility: 'bg-card',
    source: 'alert.tsx 全 variant の面 ／ card.tsx Card の面',
    foreground: 'success',
    surface: 'card',
    kind: 'text',
  },
  {
    // hover / aria-expanded の面。Button は hover 時に濃い文字色へ替わるが、Badge は
    // 弱い文字色のまま同じ面に載るため、そちらを surface の相手に取る。
    utility: 'bg-muted',
    source:
      'button.tsx variant=outline / ghost（hover・aria-expanded の面）・' +
      'badge.tsx variant=outline / ghost（hover の面）',
    foreground: 'muted-foreground',
    surface: 'muted',
    kind: 'text',
  },
  {
    // default variant の hover 面。白文字が載る（Issue #50 で不透明度による明化を撤去した箇所）。
    utility: 'bg-primary-hover',
    source: 'button.tsx / badge.tsx variant=default（hover の面）',
    foreground: 'primary-foreground',
    surface: 'primary-hover',
    kind: 'text',
  },
  {
    utility: 'bg-secondary',
    source: 'button.tsx / badge.tsx variant=secondary（面）',
    foreground: 'secondary-foreground',
    surface: 'secondary',
    kind: 'text',
  },
  {
    utility: 'text-card-foreground',
    source: 'alert.tsx variant=default の本文 ／ card.tsx Card の本文',
    foreground: 'card-foreground',
    surface: 'card',
    kind: 'text',
  },
  {
    // 不透明度付きのエラー面に載る場合の比は既存の bg-destructive/10・/20 のエントリが
    // 担うため、ここでは白い面（Alert / FieldError / invalid な Field）の出現を受け持つ。
    utility: 'text-destructive',
    source:
      'alert.tsx variant=destructive ／ field.tsx FieldError・data-[invalid=true] の Field ／' +
      'button.tsx / badge.tsx variant=destructive の文字',
    foreground: 'destructive',
    surface: 'card',
    kind: 'text',
  },
  {
    // hover 時にこの文字色へ替わる箇所は同時に面塗りも替わるため、白背景ではなく
    // その面を相手に取る（最も条件の厳しい隣接色）。
    utility: 'text-foreground',
    source:
      'button.tsx variant=outline / ghost（hover・aria-expanded の文字）・' +
      'badge.tsx variant=outline の文字 ／ alert.tsx のリンク hover ／ input.tsx の file ボタン',
    foreground: 'foreground',
    surface: 'muted',
    kind: 'text',
  },
  {
    // 白い面に載る出現が大半だが、Badge の hover ではこの文字色が面塗りと同時に出るため、
    // そちらを相手に取る（最も条件の厳しい隣接色）。
    utility: 'text-muted-foreground',
    source:
      'alert.tsx AlertDescription ／ card.tsx CardDescription ／ field.tsx FieldDescription・' +
      '区切りラベル ／ input.tsx / textarea.tsx の placeholder ／ badge.tsx の hover の文字',
    foreground: 'muted-foreground',
    surface: 'muted',
    kind: 'text',
  },
  {
    utility: 'text-primary',
    source:
      'button.tsx / badge.tsx variant=link の文字 ／ field.tsx FieldDescription 内リンクの hover',
    foreground: 'primary',
    surface: 'background',
    kind: 'text',
  },
  {
    // **このエントリは取り除いてはならない。** bg-primary を非テキストとして登録している以上、
    // 選択色の面に載る白文字の 4.5:1 を担保するのはここだけである（要件 2.2 の趣旨）。
    utility: 'text-primary-foreground',
    source:
      'button.tsx / badge.tsx variant=default の文字 ／ ' +
      'checkbox.tsx / radio-group.tsx（data-checked の印）',
    foreground: 'primary-foreground',
    surface: 'primary',
    kind: 'text',
  },
  {
    utility: 'text-secondary-foreground',
    source: 'button.tsx / badge.tsx variant=secondary の文字',
    foreground: 'secondary-foreground',
    surface: 'secondary',
    kind: 'text',
  },
  {
    utility: 'text-success',
    source: 'alert.tsx variant=success の文字',
    foreground: 'success',
    surface: 'card',
    kind: 'text',
  },
];

/**
 * 検証表に載せない色ユーティリティと、その理由。
 *
 * 「合格しているから除外」ではなく「WCAG の対象外であるか、別Issueで扱う」ものだけを載せる。
 * 理由なしの除外を許すと、このガードは #48 で潰した空振りガードと同じものになる。
 */
const EXEMPT_UTILITIES: ReadonlyArray<{ readonly utility: string; readonly reason: string }> = [
  {
    // **この除外は「枠が信号を運べる部品」に限って成立する。**
    // 面が透明な部品（input / textarea / button / badge）では、エラー時に枠色が
    // border-input（中立の灰）から destructive（赤）へ変わるため、枠だけで状態が読める。
    // 面をアクション色で塗る部品（checkbox / radio-group の選択済み）はこの前提を満たさない。
    // 意匠を Airbnb 系へ差し替えてアクション色と危険色の色相が約 14 度まで近づいた結果、
    // 「選択済み」の面（primary）と「エラー」の枠（destructive）の比が 1.35:1 になり、
    // 枠は信号を運べなくなった。そちらはリング自身に 3:1 を要求する（下の USAGE_PAIRS）。
    utility: 'ring-destructive/20',
    reason:
      '面が透明な部品（input / textarea / button / badge）の aria-invalid のリングは装飾。' +
      'エラーであることの伝達は中立の枠色から赤へ変わるエラー枠と role="alert" の可視文言が担う。',
  },
  {
    utility: 'ring-foreground/10',
    reason: 'card.tsx の外枠。情報を持たない純装飾のため SC 1.4.11 の対象外。',
  },
  {
    utility: 'bg-input/50',
    reason:
      'input / textarea の disabled 時の面塗り。WCAG 1.4.3 は無効化された部品を' +
      'コントラスト要件の対象外としている。',
  },
  {
    // separator.tsx は罫線そのものを面塗りで描く（高さ 1px の要素）ため、色ユーティリティは
    // border-* ではなく bg-* として現れる。装飾用の値のまま据え置くことは要件 4.2 の要求で
    // あり、識別可能性を理由にこの色を濃くしてはならない。
    utility: 'bg-border',
    reason:
      'separator.tsx の区切り線の面塗り。内容の区切りを示すだけで部品の存在・境界・状態を' +
      '伝えないため、情報を持たない純装飾として SC 1.4.11 の対象外（要件 4.2）。',
  },
  {
    utility: 'border-border',
    reason:
      'table.tsx の行区切りと page-header.tsx の見出し下の罫線。いずれも内容の区切りを示すだけで' +
      '部品の存在・境界・状態を伝えないため、bg-border と同じく純装飾として SC 1.4.11 の対象外' +
      '（要件 4.2）。行の識別は罫線ではなくセルの内容が担う。',
  },
];

// --- 数値検証 -----------------------------------------------------------------------

/** 前景・下地それぞれのアルファ合成を解いて実効コントラスト比を求める。 */
function effectiveRatio(pair: UsagePair): {
  readonly ratio: number;
  readonly foregroundHex: string;
  readonly surfaceHex: string;
} {
  const backdrop = resolveSemanticColor(pair.backdrop ?? 'background');
  const surfaceBase = resolveSemanticColor(pair.surface);
  const surfaceHex =
    pair.surfaceAlpha === undefined
      ? surfaceBase
      : compositeOver(surfaceBase, backdrop, pair.surfaceAlpha);
  const foregroundBase = resolveSemanticColor(pair.foreground);
  const foregroundHex =
    pair.foregroundAlpha === undefined
      ? foregroundBase
      : compositeOver(foregroundBase, surfaceHex, pair.foregroundAlpha);
  return { ratio: contrastRatio(foregroundHex, surfaceHex), foregroundHex, surfaceHex };
}

describe('アルファ合成後の実効コントラスト（Issue #50 / Requirements 5.2）', () => {
  it('検証表が空でない（空振り緑の防止）', () => {
    expect(USAGE_PAIRS.length).toBeGreaterThan(0);
  });

  for (const pair of USAGE_PAIRS) {
    const threshold = pair.kind === 'text' ? AA_NORMAL_TEXT_RATIO : AA_NON_TEXT_RATIO;
    it(`${pair.utility}（${pair.source}）は ${threshold}:1 以上`, () => {
      const { ratio, foregroundHex, surfaceHex } = effectiveRatio(pair);
      expect(
        ratio,
        `${pair.utility}: ${pair.foreground}(${foregroundHex}) on ${surfaceHex} → ` +
          `${ratio.toFixed(3)}:1（要求 ${threshold}:1・${pair.source}）`,
      ).toBeGreaterThanOrEqual(threshold);
    });
  }
});

// --- 網羅ガード ---------------------------------------------------------------------

/** 部品ソース（src/components/*.tsx）を全て読む。 */
function readComponentSources(): ReadonlyArray<{ readonly file: string; readonly source: string }> {
  return readdirSync(componentsDir)
    .filter((name) => name.endsWith('.tsx'))
    .map((file) => ({ file, source: readFileSync(join(componentsDir, file), 'utf8') }));
}

/**
 * 色ユーティリティのパターン。不透明度は**任意**とし、`bg-primary/80`（付き）と
 * `border-input`（なし）の双方に一致する（Requirements 5.1）。
 *
 * 一致するのは字面だけであり、この段階では `text-sm` `border-0` `bg-transparent` のような
 * 色でない語も通る。色か否かの判定は `isColorUtility` が担う。
 */
const COLOR_UTILITY_PATTERN =
  /^(?:bg|text|border|ring|outline|fill|stroke)-[a-z0-9-]+(?:\/\d{1,3})?$/;

/** ユーティリティから意味論名を取り出す。`border-input` → `input`、`bg-primary/80` → `primary`。 */
function semanticNameOf(utility: string): string {
  const withoutAlpha = utility.split('/')[0]!;
  return withoutAlpha.slice(withoutAlpha.indexOf('-') + 1);
}

/**
 * 意味論名が theme.css で色として解決できるかを判定する（design.md D6）。
 *
 * 判定は `resolveSemanticColor` が throw することをもって行い、非色語の一覧を別に持たない。
 * 一覧を持つと Tailwind のユーティリティが増えるたびに二重更新が要り、それ自体が
 * 同期漏れの発生源になる（意味論名 → hex の対応表を手写ししないのと同じ理由）。
 */
function isColorUtility(utility: string): boolean {
  try {
    resolveSemanticColor(semanticNameOf(utility));
    return true;
  } catch {
    return false;
  }
}

/**
 * ソースから「色ユーティリティの字面を持つ語」を拾う（色として解決できるかは問わない）。
 *
 * `dark:` を含むクラスは、ダークバリアントが `.dark` 祖先セレクタへ再定義されているため
 * `.dark` が付かない限り一切適用されない。ダークパレットが未整備のため意図的に無効化して
 * いる状態であり、その前提のもとで検証対象から除外する（Requirements 5.7 の条件節）。
 *
 * **この除外は前提つきであり、前提は機械検証されている。** 無効化宣言の存在・`.dark` を
 * 付与する箇所が無いこと・生成 CSS が OS 設定で有効になる形を持たないことは
 * `app-integration.test.ts` の「ダークモードが導入されていない（Requirements 6.6 / 5.7 の
 * 前提）」と各アプリの「7. ダークモードの無効化」が固定している。前提が崩れれば
 * そちらが落ちる。**ここに文章で書くだけにしてはならない**——前提が崩れたとき、この除外は
 * 未整備のダーク配色を隠す側へ反転するためである。
 *
 * 抽出器を色ユーティリティ全般へ広げたことで、この除外は不透明度付き（`dark:bg-input/30`
 * 等）だけでなく不透明度なし（`dark:border-input`）にも及ぶようになった。ダークモード着手時
 * にはこの除外を外し、ダーク下地での実効コントラストを検証すること。
 */
function extractUtilityTokens(source: string): readonly string[] {
  const found: string[] = [];
  for (const rawToken of source.split(/[\s"'`]+/)) {
    if (rawToken.includes('dark:')) continue;
    // 先頭の variant 連鎖（`[a]:hover:` `*:data-[slot=x]:` `focus-visible:` 等）を落として
    // ユーティリティ本体だけを見る。variant 部分に `/` は現れない。
    const utility = rawToken.slice(rawToken.lastIndexOf(':') + 1);
    if (COLOR_UTILITY_PATTERN.test(utility)) {
      found.push(utility);
    }
  }
  return found;
}

/** 部品ソースから色ユーティリティを抽出する（返り値は全て `isColorUtility` を満たす）。 */
function extractColorUtilities(source: string): readonly string[] {
  return extractUtilityTokens(source).filter(isColorUtility);
}

/** パターンには一致したが色として解決できず捨てられた語（下の固定検証だけが使う）。 */
function extractNonColorTokens(source: string): readonly string[] {
  return extractUtilityTokens(source).filter((utility) => !isColorUtility(utility));
}

/**
 * 実ソースから落ちた（色として解決できなかった）語の固定値。
 *
 * **この一覧は色／非色の判定には一切使わない。** 判定は D6 のとおり `resolveSemanticColor` の
 * throw のみが行う（`isColorUtility`）。ここにあるのは判定結果を写した観測値であり、
 * 分類の入力ではない。ホワイトリストとして参照した瞬間に D6 が壊れるので、そうしないこと。
 *
 * なぜ集合ごと固定するか:
 * D6 の「解決に失敗したら除外」という方式は、綴り誤り（`bg-primry`）や、意味論名でない
 * 既定色（`text-white` / `bg-black` / `text-inherit` 等）を **未分類として赤化させずに
 * 黙って捨てる**。不透明度を必須としていた頃は `bg-primry/50` のような語も未分類として
 * 赤化していたため、抽出器の拡張はこの経路に限っては検出力を下げる方向に働く。
 * 固定フィクスチャによる自己検証は実ソースを見ていないためこの穴を塞げない。
 * そこで「落とした語の集合」そのものを実ソースから取り出して固定し、増減の双方で赤化させる。
 *
 * 集合が変わったときの対応: 増えた語が本当に色でない（寸法・字形・透明・切り抜き等）ことを
 * 一件ずつ確認してからこの一覧へ加える。色のつもりの語が混ざっていれば、それは
 * 綴り誤りか意味論トークン化されていない色であり、部品側を直すのが正しい。
 */
const NON_COLOR_TOKENS: readonly string[] = [
  'bg-clip-padding',
  'bg-transparent',
  'border-0',
  'border-b',
  'border-t',
  'border-transparent',
  'ring-1',
  'ring-3',
  'text-2xl',
  'text-balance',
  'text-base',
  'text-center',
  'text-current',
  'text-left',
  'text-lg',
  'text-pretty',
  'text-right',
  'text-sm',
  'text-xl',
  'text-xs',
];

describe('色ユーティリティ抽出器の自己検証（Requirements 5.1, 5.7 / design.md D6）', () => {
  const sources = readComponentSources();
  const colorUtilities = [
    ...new Set(sources.flatMap(({ source }) => extractColorUtilities(source))),
  ].sort();

  it('不透明度あり・なしの双方を拾う', () => {
    expect(extractColorUtilities('<div className="border-input bg-primary/5" />')).toEqual([
      'border-input',
      'bg-primary/5',
    ]);
  });

  it('色として解決できない語は拾わない（寸法・数値・透明・切り抜き・字形）', () => {
    expect(
      extractColorUtilities(
        'text-sm text-2xl border-0 border-t ring-1 ring-3 bg-transparent bg-clip-padding text-current text-balance',
      ),
    ).toEqual([]);
  });

  it('variant 連鎖を落としてユーティリティ本体だけを見る', () => {
    expect(
      extractColorUtilities(
        'focus-visible:ring-destructive/20 *:data-[slot=alert-description]:text-success',
      ),
    ).toEqual(['ring-destructive/20', 'text-success']);
  });

  it('dark: 専用の指定は色として解決できても拾わない（Requirements 5.7）', () => {
    expect(extractColorUtilities('dark:border-input hover:dark:bg-muted/50')).toEqual([]);
  });

  it('実ソースからの抽出が空でなく、不透明度あり・なしの双方を含む（空振り緑の防止）', () => {
    // 設計の不変条件: 抽出結果が空配列なら空振りとみなして失敗させる。
    expect(sources.length).toBeGreaterThan(0);
    expect(colorUtilities.length).toBeGreaterThan(0);
    // パターン拡張が実ソースへ効いていることの確認。不透明度なしが 0 件なら拡張が
    // 効いていない（＝拡張前と同じものを見ている）。
    expect(
      colorUtilities.filter((utility) => utility.includes('/')),
      '不透明度付きの色ユーティリティが 1 件も抽出できていない',
    ).not.toEqual([]);
    expect(
      colorUtilities.filter((utility) => !utility.includes('/')),
      '不透明度なしの色ユーティリティが 1 件も抽出できていない（パターンの拡張が効いていない）',
    ).not.toEqual([]);
  });

  it('色として解決できず捨てた語の集合が固定値と一致する（黙って捨てる穴の封じ）', () => {
    const dropped = [
      ...new Set(sources.flatMap(({ source }) => extractNonColorTokens(source))),
    ].sort();
    expect(
      dropped,
      '色として解決できず捨てられた語の集合が変化しました。増えた語が本当に色でないことを' +
        '一件ずつ確認し、色のつもりの語（綴り誤り・意味論トークン化されていない色）が' +
        `混ざっていないか検めること: ${dropped.join(', ')}`,
    ).toEqual(NON_COLOR_TOKENS);
  });
});

describe('網羅ガード: 部品の色ユーティリティが全て分類されている（Issue #50 / Requirements 5.1, 5.2）', () => {
  const sources = readComponentSources();
  const foundUtilities = [
    ...new Set(sources.flatMap(({ source }) => extractColorUtilities(source))),
  ].sort();
  const classified = [
    ...new Set([
      ...USAGE_PAIRS.map((pair) => pair.utility),
      ...EXEMPT_UTILITIES.map((entry) => entry.utility),
    ]),
  ].sort();

  it('部品ソースを読めており、抽出が機能している（空振り緑の防止）', () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(foundUtilities.length).toBeGreaterThan(0);
  });

  it('部品が使う色ユーティリティは全て検証表か除外理由付きリストにある', () => {
    // 新しい色指定を部品へ足したら、必ず USAGE_PAIRS で検証させるか
    // EXEMPT_UTILITIES で理由を書かせるための網羅ガード
    // （theme-sync.test.ts の「役割対応表に無い色変数の混入防止」と同じ流儀）。
    const unclassified = foundUtilities.filter((utility) => !classified.includes(utility));
    expect(
      unclassified,
      `検証表にも除外リストにも無い色ユーティリティが部品にあります（${unclassified.length} 件）: ` +
        `${unclassified.join(', ')}`,
    ).toEqual([]);
  });

  it('検証表・除外リストに部品で使われていないクラスが残っていない', () => {
    // 部品から消したクラスが表に残り続けると「守っているつもり」の空振りになる。
    const stale = classified.filter((utility) => !foundUtilities.includes(utility));
    expect(
      stale,
      `部品で使われていない色ユーティリティが検証表／除外リストに残っています: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('除外はすべて理由が書かれている', () => {
    for (const entry of EXEMPT_UTILITIES) {
      expect(entry.reason.length, `${entry.utility} の除外理由が空です`).toBeGreaterThan(20);
    }
  });
});

// --- 子孫指定の色ガード -------------------------------------------------------------

/**
 * 親 variant が子（説明文など）へ渡す色指定（`*:data-[slot=…]:text-…`）の検証対象。
 *
 * なぜ上の網羅ガードと別立てが要るか:
 * 網羅ガードは variant 連鎖を落としてユーティリティ本体だけを見るため、「どの子へ色を渡すか」
 * という束縛（`*:data-[slot=…]:`）を一切見ていない。同じ色ユーティリティが他の箇所でも
 * 使われていれば、束縛が消えても抽出される集合は変わらない。
 * PR #56 のレビューで見つかった欠陥は「不透明度を外すときに子孫指定ごと削除した」ことで
 * 起きた。子（AlertDescription）は自前で
 * `text-muted-foreground` を持つため、親からの指定が消えると variant の状態色は説明文へ
 * 一切届かない。それでいてクラス名の集合は何も壊れないので、既存のガードは全て緑のまま通る。
 * 「子へ渡す色」を独立に抽出して数値検証し、消えた場合も薄すぎる場合も赤化させる。
 */
interface DescendantTextPair {
  /** 部品ソースに現れる子孫指定クラス（突き合わせキー）。 */
  readonly utility: string;
  /** 出典（どの部品のどの variant か）。 */
  readonly source: string;
  /** 子へ渡す前景の意味論名。 */
  readonly foreground: string;
  /** 子が載る下地の意味論名。 */
  readonly surface: string;
  /** テキストか非テキストか（しきい値が変わる）。 */
  readonly kind: 'text' | 'non-text';
}

const DESCENDANT_TEXT_PAIRS: readonly DescendantTextPair[] = [
  {
    utility: '*:data-[slot=alert-description]:text-success',
    source: 'alert.tsx variant=success の説明文',
    foreground: 'success',
    surface: 'card',
    kind: 'text',
  },
  {
    utility: '*:data-[slot=alert-description]:text-destructive',
    source: 'alert.tsx variant=destructive の説明文',
    foreground: 'destructive',
    surface: 'card',
    kind: 'text',
  },
];

/**
 * 子孫の色指定を抽出する。
 *
 * 不透明度付き（`…:text-success/90` 等）もあえて拾う。拾えば下の突き合わせで
 * 「表に無いクラス」として落ちるか、表に載せた場合は合成後の値で数値検証されるため、
 * 不透明度による AA 割れ（Issue #50）と子孫指定の消失の両方が同じ一本のガードに掛かる。
 */
const DESCENDANT_TEXT_PATTERN = /\*:data-\[slot=[a-z0-9-]+\]:text-[a-z0-9-]+(?:\/\d{1,3})?/g;

function extractDescendantTextUtilities(source: string): readonly string[] {
  return [...source.matchAll(DESCENDANT_TEXT_PATTERN)].map((match) => match[0]);
}

describe('extractDescendantTextUtilities の自己検証（Issue #60）', () => {
  it('不透明度あり・なしの双方を、先頭と末尾の位置で漏らさず拾う', () => {
    expect(
      extractDescendantTextUtilities(
        '*:data-[slot=card-title]:text-foreground mid *:data-[slot=alert-description]:text-muted/70',
      ),
    ).toEqual([
      '*:data-[slot=card-title]:text-foreground',
      '*:data-[slot=alert-description]:text-muted/70',
    ]);
  });

  it('前置きの variant 連鎖があっても子孫指定の本体を取り出す', () => {
    expect(extractDescendantTextUtilities('hover:*:data-[slot=x]:text-primary')).toEqual([
      '*:data-[slot=x]:text-primary',
    ]);
  });

  it('子孫指定でない色ユーティリティを拾わない', () => {
    expect(extractDescendantTextUtilities('text-foreground bg-primary/50')).toEqual([]);
  });

  it('text- 以外の子孫指定を拾わない（本ガードの対象は文字色である）', () => {
    expect(extractDescendantTextUtilities('*:data-[slot=x]:bg-primary')).toEqual([]);
  });
});

describe('子孫指定の色ガード: 親 variant が子へ渡す色（PR #56 レビュー指摘1）', () => {
  const sources = readComponentSources();
  const found = [
    ...new Set(sources.flatMap(({ source }) => extractDescendantTextUtilities(source))),
  ].sort();
  const declared = [...new Set(DESCENDANT_TEXT_PAIRS.map((pair) => pair.utility))].sort();

  it('抽出が機能している（空振り緑の防止）', () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(
      found.length,
      '子孫への色指定が 1 つも見つからない。抽出が壊れているか、指定が部品から消えている',
    ).toBeGreaterThan(0);
  });

  it('部品の子孫色指定は全て検証表にある', () => {
    const unclassified = found.filter((utility) => !declared.includes(utility));
    expect(
      unclassified,
      `検証表に無い子孫色指定が部品にあります: ${unclassified.join(', ')}`,
    ).toEqual([]);
  });

  it('検証表に部品で使われていない子孫色指定が残っていない', () => {
    // 今回の欠陥（子孫指定の削除）はこの向きで落ちる。
    const stale = declared.filter((utility) => !found.includes(utility));
    expect(
      stale,
      `部品で使われていない子孫色指定が検証表に残っています（削除された可能性）: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  for (const pair of DESCENDANT_TEXT_PAIRS) {
    const threshold = pair.kind === 'text' ? AA_NORMAL_TEXT_RATIO : AA_NON_TEXT_RATIO;
    it(`${pair.utility}（${pair.source}）は ${threshold}:1 以上`, () => {
      const foregroundHex = resolveSemanticColor(pair.foreground);
      const surfaceHex = resolveSemanticColor(pair.surface);
      const ratio = contrastRatio(foregroundHex, surfaceHex);
      expect(
        ratio,
        `${pair.utility}: ${foregroundHex} on ${surfaceHex} → ${ratio.toFixed(3)}:1` +
          `（要求 ${threshold}:1・${pair.source}）`,
      ).toBeGreaterThanOrEqual(threshold);
    });
  }
});

// --- color-mix ガード ---------------------------------------------------------------

/**
 * `color-mix()` は色ユーティリティの正規表現をすり抜けるため、別途検出して
 * 実測値付きの許可リストへの登録を必須にする（ホールを塞ぐ）。
 *
 * 照合はファイル単位ではなく **出現箇所（file + 式）単位**で行う（PR #56 レビュー指摘2）。
 * ファイル名だけで突き合わせると、既に許可済みの部品へ 2 個目の color-mix を足しても
 * 集合が変わらず素通りしてしまう。
 *
 * 許可リストは JSON に外出しし、survey-web の E2E（実ブラウザで合成後の色を実測する側）と
 * 同じ 1 つの値を読む。実測値を 2 箇所に手書きすれば、それ自体が drift の発生源になるため。
 */
interface ColorMixEntry {
  readonly file: string;
  readonly expression: string;
  /** 実ブラウザで実測した合成後の実効色（6桁 hex）。E2E が一致を検証する。 */
  readonly measuredHex: string;
  /** その面に載る前景の意味論名。 */
  readonly foreground: string;
  readonly kind: 'text' | 'non-text';
  readonly reason: string;
}

const colorMixAllowlist = (
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'color-mix-allowlist.json'),
      'utf8',
    ),
  ) as { readonly entries: readonly ColorMixEntry[] }
).entries;

/**
 * `color-mix(` の各出現を、括弧の深さを数えて 1 つずつ切り出す。
 *
 * `var(--a)` が入れ子になるため、対応する `)` は正規表現では特定できない。
 */
function extractColorMixExpressions(source: string): readonly string[] {
  const needle = 'color-mix(';
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start === -1) return found;
    let depth = 0;
    let end = -1;
    for (let i = start + needle.length - 1; i < source.length; i += 1) {
      const character = source[i];
      if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      throw new Error(`color-mix( の括弧が閉じていません: ${source.slice(start, start + 80)}`);
    }
    found.push(source.slice(start, end + 1));
    from = end + 1;
  }
}

/** 照合キー。同一ファイル内の 2 個目以降も独立に照合させるため式を含める。 */
function colorMixKey(file: string, expression: string): string {
  return `${file}::${expression}`;
}

describe('color-mix ガード: 静的検証できない色指定を野放しにしない（Issue #50 / PR #56 レビュー指摘2）', () => {
  const sources = readComponentSources();
  const found = sources
    .flatMap(({ file, source }) =>
      extractColorMixExpressions(source).map((expression) => colorMixKey(file, expression)),
    )
    .sort();
  const allowed = colorMixAllowlist
    .map((entry) => colorMixKey(entry.file, entry.expression))
    .sort();

  it('抽出器が入れ子括弧を含む式を丸ごと取り出せる（空振り緑の防止）', () => {
    // 許可リストが将来空になっても、抽出器が壊れたまま緑にならないようフィクスチャで自己検証する。
    const fixture =
      'a: color-mix(in oklch, var(--x), var(--y) 5%); b: color-mix(in srgb, #fff, #000 10%);';
    expect(extractColorMixExpressions(fixture)).toEqual([
      'color-mix(in oklch, var(--x), var(--y) 5%)',
      'color-mix(in srgb, #fff, #000 10%)',
    ]);
    expect(extractColorMixExpressions('色指定なし')).toEqual([]);
  });

  it('color-mix の全出現が許可リストに登録されている（出現箇所単位）', () => {
    // color-mix は oklch 等の色空間で合成されるため hex ベースの静的計算ができない。
    // 使うこと自体は禁じないが、実ブラウザで測った実効色と理由の登録を強制する。
    const undocumented = found.filter((key) => !allowed.includes(key));
    expect(
      undocumented,
      `許可リストに無い color-mix の出現: ${undocumented.join(' / ')}`,
    ).toEqual([]);
  });

  it('許可リストに部品から消えた出現が残っていない', () => {
    const stale = allowed.filter((key) => !found.includes(key));
    expect(
      stale,
      `部品に存在しない color-mix が許可リストに残っています: ${stale.join(' / ')}`,
    ).toEqual([]);
  });

  it('許可リストが空でない（登録対象があるうちは空振りさせない）', () => {
    expect(colorMixAllowlist.length).toBe(found.length);
  });

  for (const entry of colorMixAllowlist) {
    const threshold = entry.kind === 'text' ? AA_NORMAL_TEXT_RATIO : AA_NON_TEXT_RATIO;
    it(`${entry.file} の ${entry.expression} は実測色で ${threshold}:1 以上`, () => {
      expect(
        entry.measuredHex,
        `${entry.file}: measuredHex が 6桁 hex でない（実ブラウザで実測してから登録すること）`,
      ).toMatch(/^#[0-9A-F]{6}$/);
      expect(entry.reason.length, `${entry.file} の理由が空です`).toBeGreaterThan(20);

      const foregroundHex = resolveSemanticColor(entry.foreground);
      const ratio = contrastRatio(foregroundHex, entry.measuredHex);
      expect(
        ratio,
        `${entry.expression}: ${entry.foreground}(${foregroundHex}) on 実測 ${entry.measuredHex}` +
          ` → ${ratio.toFixed(3)}:1（要求 ${threshold}:1）`,
      ).toBeGreaterThanOrEqual(threshold);
    });
  }
});


// フォーカス指標の色の隣接コントラスト（Requirements 2.3, 2.4 / SC 1.4.11）。
//
// **この検証が無かった。** `:focus-visible { outline: 2px solid var(--ring) }` は
// ユーティリティではなく `@layer base` のグローバル既定なので、上の網羅ガード（部品ソースから
// 色ユーティリティを抽出する）の走査対象に一度も入っていない。結果として `--ring` の値が
// 何であるかを誰も検証していなかった。
//
// 判定の相手は**要素の面色ではなく親の背景**である。輪郭は `outline-offset` により要素の
// 2px 外側へ描かれ、その隙間には親の背景が見えるためである。したがってアクション色で塗った
// ボタンの面色に対する比は問わない（輪郭がそこへ接しない）。
// **この推論は offset が 0 でないことに依存する。** offset を 0 にする変更を入れるときは、
// 判定の相手を面色側へ変えること。
describe('フォーカス指標の色の隣接コントラスト（Requirements 2.3, 2.4）', () => {
  /** 輪郭の外側に見えうる面（ページ・カード・ミュート面・副次面・ポップオーバー）。 */
  const ADJACENT_SURFACES = ['background', 'card', 'muted', 'secondary', 'popover'] as const;

  it('outline-offset が 0 ではない（隣接色を親の背景と見なす前提の確認）', () => {
    // 前提そのものが崩れたら、下の判定は「測ってはいるが違うものを測っている」状態になる。
    const offset = /:focus-visible\s*\{[^}]*outline-offset:\s*([^;]+);/.exec(themeCss)?.[1]?.trim();
    expect(offset, ':focus-visible に outline-offset がありません').toBeDefined();
    expect(offset, `outline-offset が ${offset} です。0 だと輪郭が要素の面色に接します`).not.toMatch(
      /^0(px|rem|em)?$/,
    );
  });

  it.each(ADJACENT_SURFACES)('輪郭の色は %s に対して 3:1 以上', (surface) => {
    const ring = resolveSemanticColor('ring');
    const background = resolveSemanticColor(surface);
    const ratio = contrastRatio(ring, background);
    expect(
      ratio,
      `輪郭(${ring}) と ${surface}(${background}) のコントラストが ${ratio.toFixed(2)}:1 で ` +
        `${AA_NON_TEXT_RATIO}:1 を下回ります。キーボード操作時に現在位置が見えません。`,
    ).toBeGreaterThanOrEqual(AA_NON_TEXT_RATIO);
  });

  it('輪郭の色はアクション色と同値ではない', () => {
    // 同値だと、アクション色で塗った面の周囲で輪郭が消える（offset の隙間が親背景でも、
    // 面の縁と輪郭が同色である状態は指標として弱い）。
    expect(
      resolveSemanticColor('ring'),
      '輪郭の色がアクション色と同値です',
    ).not.toBe(resolveSemanticColor('primary'));
  });
});


// 選択済みの面をアクション色で塗る部品のエラー指標（Requirements 2.2, 5.2 / SC 1.4.11）。
//
// shadcn の aria-invalid 表現は「枠がエラー色へ変わる」ことを主たる信号とし、リングは装飾として
// 淡い段（/20）に置く。この分担は **面が透明な部品でしか成立しない**。面が透明なら枠色は
// 中立の灰（border-input）から赤（destructive）へ変わり、色相の変化そのものが信号になる。
//
// 選択済みの面をアクション色で塗る部品（checkbox / radio-group）はこの前提を満たさない。
// 意匠を Airbnb 系へ差し替えてアクション色が寒色から暖色へ移った結果、アクション色と危険色は
// 色相が約 14 度しか離れず（差し替え前は約 123 度）、相互コントラストは 1.35:1 になった。
// つまり「選択済み」の面の上に「エラー」の枠を置いても、両者は同じ赤に見える。
//
// **この事故は色相の変化であって輝度の変化ではない。** 面も枠も単体では頁背景に対して基準を
// 満たすため、対背景比を見るガードはすべて緑のまま通る（差し替え前の緑と赤の組も相互比は
// 1.29:1 で、両者を分けていたのは輝度ではなく色相だった）。したがって残る手掛かりはリングだけで、
// リング自身が SC 1.4.11 の 3:1 を満たしていなければ、エラー状態は選択済み状態と区別できない。
//
// 判定の相手は要素の面色ではなく頁背景である（リングは枠の外側へ描かれるため）。
// 段は表へ書き写さず **部品ソースから実値を引く**。書き写すと部品を戻しても表が緑のままになる
// （実測: 検証表へ /60 を足しただけの状態では、部品を /20 へ戻しても 393 件すべて緑だった）。
const CHECKED_FILL_IS_ACTION_COLOR = ['checkbox.tsx', 'radio-group.tsx'] as const;

/** `dark:` 修飾の付かない `aria-invalid:ring-destructive/<段>` の段を取り出す。 */
function invalidRingAlpha(source: string): number | undefined {
  const match = /(?<!dark:)aria-invalid:ring-destructive\/(\d{1,3})\b/.exec(source);
  return match === null ? undefined : Number(match[1]) / 100;
}

describe('選択済みの面をアクション色で塗る部品のエラー指標（Requirements 2.2, 5.2）', () => {
  const sources = new Map(readComponentSources().map((entry) => [entry.file, entry.source]));

  describe('invalidRingAlpha の自己検証（Issue #60）', () => {
    it('dark: 修飾の段を拾わない（ダークは本 spec の Non-Goals であり判定に混ぜない）', () => {
      expect(invalidRingAlpha('dark:aria-invalid:ring-destructive/40')).toBeUndefined();
    });

    it('dark: が先に現れても非 dark の段を拾う（順序に頼っていないことの証明）', () => {
      expect(
        invalidRingAlpha('dark:aria-invalid:ring-destructive/40 aria-invalid:ring-destructive/60'),
      ).toBe(0.6);
    });

    it('リングが無ければ undefined を返す（0 と取り違えない）', () => {
      expect(invalidRingAlpha('aria-invalid:border-destructive')).toBeUndefined();
    });
  });

  it.each(CHECKED_FILL_IS_ACTION_COLOR)(
    '%s は選択済みの面をアクション色で塗る（判定の前提の確認）',
    (file) => {
      // 前提が崩れたら、下の判定は「測ってはいるが違うものを測っている」状態へ静かに移る。
      const source = sources.get(file);
      expect(source, `${file} を読み込めていません`).toBeDefined();
      expect(
        source,
        `${file} が data-checked:bg-primary を持ちません。選択済みの面がアクション色でなくなったなら、` +
          'エラーの枠が信号を運べるようになるので判定ごと見直すこと',
      ).toContain('data-checked:bg-primary');
    },
  );

  it.each(CHECKED_FILL_IS_ACTION_COLOR)('%s のエラーリングは頁背景に対して 3:1 以上', (file) => {
    const alpha = invalidRingAlpha(sources.get(file) ?? '');
    expect(alpha, `${file} に aria-invalid のエラーリングがありません`).toBeDefined();

    const background = resolveSemanticColor('background');
    const ring = compositeOver(resolveSemanticColor('destructive'), background, alpha ?? 0);
    const ratio = contrastRatio(ring, background);
    expect(
      ratio,
      `${file}: エラーリング(destructive/${((alpha ?? 0) * 100).toFixed(0)} → ${ring}) と ` +
        `背景(${background}) が ${ratio.toFixed(2)}:1 で ${AA_NON_TEXT_RATIO}:1 を下回ります。` +
        '選択済みの面はアクション色で塗られ、エラーの枠はその面と 1.35:1 しかないため、' +
        'リングが見えないとエラー状態を選択済み状態と区別できません。',
    ).toBeGreaterThanOrEqual(AA_NON_TEXT_RATIO);
  });
});

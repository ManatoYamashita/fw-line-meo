// @vitest-environment jsdom
//
// 成功の表示の色以外の手がかり。
//
// 成功色（--color-success）はアクション色と色相の差が 1 度に満たず、相互比も 1.13:1 しかない
// （design-tokens の test/colors.test.ts「成功とアクションの識別」が前提を固定する）。成功の通知の文字は、
// リンクや押しボタンの文字と同じ色に見える。したがって成功であることは、色ではなく印と文言で伝える。
//
// 本テストは Web の各面の「成功の表示」を全件で照合する:
//   1. 棚卸し — 面のソースから成功の表示の目印を拾い、SUCCESS_DISPLAYS と両方向で突き合わせる。
//      表示を足したのに表へ載せ忘れると赤くなり、載せた表示が消えても赤くなる。
//   2. 手がかり — 表示の種類ごとに、印と文言が付いていることを確かめる。
//      Alert の success 変種は部品が印を描くので、ここで部品を描いて確かめ、呼び出し側には文言を要求する。
//      それ以外の種類は、その面のテストが実描画で確かめる。ここではそのテストが実在することを確かめる。
//
// 色が見分けられるようになっても（成功色を色相で分けても）、この要求は外さない。
// 色覚の特性によっては色相の差も見えないためである。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { Alert, AlertDescription, AlertTitle } from '../src/components/alert';

afterEach(cleanup);

const tsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const appsDir = join(tsRoot, 'apps');

/** 成功の表示の目印。部品の変種・状態色のユーティリティ・Toast の種類・CSS の成功色の参照。 */
const SUCCESS_SIGNALS: readonly RegExp[] = [
  /variant=["']success["']/,
  /\b(?:text|bg|border|fill|stroke|ring|outline|decoration)-success\b/,
  /\btoast\.success\(/,
  /var\(--(?:color-)?success\)/,
  /data-type=["']success["']/,
];

type Cue =
  // Alert の success 変種。印は部品が描く（下の「部品が描く印」が確かめる）。呼び出し側は文言を渡す。
  | { readonly kind: 'alert' }
  // 部品を使わずに成功色で描く表示。印と文言はその面のテストが実描画で確かめる。
  | { readonly kind: 'own'; readonly verifiedBy: string; readonly testTitle: string };

/** 成功の表示の全件（tsRoot からの相対パス）。 */
const SUCCESS_DISPLAYS: ReadonlyArray<{ readonly file: string; readonly cue: Cue }> = [
  { file: 'apps/survey-web/src/app/s/[storeId]/draft-panel.tsx', cue: { kind: 'alert' } },
  { file: 'apps/survey-web/src/app/s/[storeId]/survey-shell.tsx', cue: { kind: 'alert' } },
  // 部品の実描画の色を測る的（E2E）。利用者には見せない画面だが、成功の表示であることは変わらない。
  { file: 'apps/survey-web/src/app/ui-check/page.tsx', cue: { kind: 'alert' } },
  { file: 'apps/dashboard-web/src/app/invite-codes/page.tsx', cue: { kind: 'alert' } },
  { file: 'apps/dashboard-web/src/app/admin/users/page.tsx', cue: { kind: 'alert' } },
  {
    // 店舗一覧の行に置く小さな文言。Alert の枠を行へ持ち込まないため、印を自前で添える。
    file: 'apps/dashboard-web/src/app/stores/store-suspension-control.tsx',
    cue: {
      kind: 'own',
      verifiedBy: 'apps/dashboard-web/test/store-suspension-control.test.tsx',
      testTitle: '成功の文言には読み上げない成功の印が添えられ、結果の前の空の領域には印を置かない',
    },
  },
  {
    // 成功の Toast を出す唯一の入口。印は AppToaster が Sonner へ渡すアイコンが描く。
    file: 'apps/dashboard-web/src/lib/action-feedback.ts',
    cue: {
      kind: 'own',
      verifiedBy: 'apps/dashboard-web/test/app-toaster.test.tsx',
      testTitle: '成功の Toast に読み上げないアイコンを渡し、失敗の Toast とは別の形にする',
    },
  },
  {
    // 成功の Toast のにじみとアイコンの色。文字は本文色で描く（色で状態を伝えない）。
    file: 'apps/dashboard-web/src/app/globals.css',
    cue: {
      kind: 'own',
      verifiedBy: 'apps/dashboard-web/test/app-toaster.test.tsx',
      testTitle: '成功の Toast に読み上げないアイコンを渡し、失敗の Toast とは別の形にする',
    },
  },
];

/** apps/<app>/src 配下のソース（.ts / .tsx / .css）を再帰的に列挙する。 */
function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSources(path);
    return /\.(?:tsx?|css)$/.test(name) ? [path] : [];
  });
}

function filesWithSuccessSignals(): string[] {
  return readdirSync(appsDir)
    .map((app) => join(appsDir, app, 'src'))
    .filter((src) => existsSync(src))
    .flatMap(listSources)
    .filter((path) => {
      const source = readFileSync(path, 'utf8');
      return SUCCESS_SIGNALS.some((signal) => signal.test(source));
    })
    .map((path) => relative(tsRoot, path).split('\\').join('/'))
    .sort();
}

/** `<Alert variant="success" …>` から対応する `</Alert>` までを取り出す（入れ子の Alert は持たない前提）。 */
function successAlertBlocks(source: string): string[] {
  return [...source.matchAll(/<Alert\b[^>]*variant=["']success["'][^>]*>([\s\S]*?)<\/Alert>/g)].map(
    (match) => match[1]!,
  );
}

describe('成功の表示の棚卸し', () => {
  describe('抽出の自己検証', () => {
    it('変種・ユーティリティ・Toast・CSS の参照をそれぞれ拾い、似た別物は拾わない', () => {
      const hits = (text: string) => SUCCESS_SIGNALS.some((signal) => signal.test(text));
      expect(hits('<Alert variant="success">')).toBe(true);
      expect(hits('className="text-xs text-success"')).toBe(true);
      expect(hits("toast.success(title)")).toBe(true);
      expect(hits('color: var(--success);')).toBe(true);
      expect(hits("[data-type='success']")).toBe(true);
      expect(hits("return { status: 'success' };")).toBe(false);
      expect(hits('text-successful')).toBe(false);
    });

    it('success 変種の Alert の中身を取り出し、別の変種は取り出さない', () => {
      const source =
        '<Alert variant="success" role={undefined}>\n  <AlertDescription>a</AlertDescription>\n</Alert>' +
        '<Alert variant="destructive"><AlertDescription>b</AlertDescription></Alert>';
      expect(successAlertBlocks(source)).toEqual(['\n  <AlertDescription>a</AlertDescription>\n']);
    });

    it('面のソースから少なくとも 1 件拾えている（空振りしていない）', () => {
      expect(filesWithSuccessSignals().length).toBeGreaterThan(0);
    });
  });

  it('成功の表示を持つファイルと SUCCESS_DISPLAYS が一致する（両方向）', () => {
    expect(
      filesWithSuccessSignals(),
      '成功の表示を足したら、色以外の手がかり（印と文言）を付けたうえで SUCCESS_DISPLAYS へ載せること',
    ).toEqual(SUCCESS_DISPLAYS.map((entry) => entry.file).sort());
  });
});

describe('成功の表示の色以外の手がかり', () => {
  describe('部品が描く印（Alert の success 変種）', () => {
    it('タイトルだけ・説明だけのどちらでも、印を直下の先頭に描いて読み上げない', () => {
      for (const children of [
        <AlertTitle key="t">保存しました</AlertTitle>,
        <AlertDescription key="d">保存しました</AlertDescription>,
      ]) {
        const { container } = render(<Alert variant="success">{children}</Alert>);
        const alert = container.querySelector('[data-slot="alert"]')!;
        const icon = alert.firstElementChild;
        expect(icon?.getAttribute('data-slot'), '成功の印が先頭にありません').toBe('success-icon');
        expect(icon?.getAttribute('aria-hidden')).toBe('true');
        cleanup();
      }
    });
  });

  const alertSites = SUCCESS_DISPLAYS.filter((entry) => entry.cue.kind === 'alert');

  it.each(alertSites.map((entry) => entry.file))('%s の success 変種の Alert は文言を持つ', (file) => {
    const blocks = successAlertBlocks(readFileSync(join(tsRoot, file), 'utf8'));
    expect(blocks.length, `${file} に success 変種の Alert が見つかりません`).toBeGreaterThan(0);
    for (const block of blocks) {
      // 文言の受け口（タイトルか説明）を通す。印だけの成功の通知は、何が成功したかを伝えない。
      expect(block, `${file}: success 変種の Alert に文言の受け口がありません`).toMatch(
        /<Alert(?:Title|Description)\b/,
      );
      // 部品が描く印と重ねない。呼び出し側が自前の svg を置くと印が 2 つになり、段組みも崩れる。
      expect(block, `${file}: success 変種の Alert に自前の印が置かれています`).not.toMatch(
        /<svg\b|Icon\b/,
      );
    }
  });

  const ownSites = SUCCESS_DISPLAYS.flatMap((entry) =>
    entry.cue.kind === 'own' ? [{ file: entry.file, ...entry.cue }] : [],
  );

  it.each(ownSites)('$file の印と文言は $verifiedBy が確かめている', ({ verifiedBy, testTitle }) => {
    const path = join(tsRoot, verifiedBy);
    expect(existsSync(path), `${verifiedBy} がありません`).toBe(true);
    // 表題で引く。テストが改名・削除されたら、照合先を失ったことがここで分かる。
    expect(readFileSync(path, 'utf8'), `${verifiedBy} に「${testTitle}」がありません`).toContain(
      `'${testTitle}'`,
    );
  });
});

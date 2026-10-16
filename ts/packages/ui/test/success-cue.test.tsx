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

import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// Toast のアイコンは AppToaster が Sonner へ渡す値がすべてである（渡すと既定のアイコンは描かれない）。
// 渡した値そのものを調べるため、Toaster を受け取った props を記録するだけのものに差し替える。
const toasterProps = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    toasterProps(props);
    return null;
  },
  toast: {},
}));

import { Alert, AlertDescription, AlertTitle } from '../src/components/alert';
import { AppToaster } from '../src/components/app-toaster';

afterEach(() => {
  cleanup();
  toasterProps.mockClear();
});

const tsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const appsDir = join(tsRoot, 'apps');

/** 面のソースを置くディレクトリ。store-detail は src を持たず app と lib に置くので、src だけでは漏れる。 */
const APP_SOURCE_DIRS = ['src', 'app', 'lib'] as const;

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
  // 成功の Toast。印は共有部品の AppToaster が Sonner へ渡すアイコンが描く（下の「Toast の印」が確かめる）。
  // その面のレイアウトが AppToaster を置いていなければ、アイコンは描かれない。
  | { readonly kind: 'toast' }
  // 部品を使わずに成功色で描く表示。印と文言はその面のテストが実描画で確かめる。
  | { readonly kind: 'own'; readonly verifiedBy: string; readonly testTitle: string };

/** 成功の表示の全件（tsRoot からの相対パス）。1 つのファイルが複数の種類の表示を持つことがある。 */
const SUCCESS_DISPLAYS: ReadonlyArray<{ readonly file: string; readonly cues: readonly Cue[] }> = [
  { file: 'apps/survey-web/src/app/s/[storeId]/draft-panel.tsx', cues: [{ kind: 'alert' }, { kind: 'toast' }] },
  { file: 'apps/survey-web/src/app/s/[storeId]/survey-shell.tsx', cues: [{ kind: 'alert' }, { kind: 'toast' }] },
  // 部品の実描画の色を測る的（E2E）。利用者には見せない画面だが、成功の表示であることは変わらない。
  { file: 'apps/survey-web/src/app/ui-check/page.tsx', cues: [{ kind: 'alert' }] },
  { file: 'apps/dashboard-web/src/app/invite-codes/page.tsx', cues: [{ kind: 'alert' }] },
  { file: 'apps/dashboard-web/src/app/admin/users/page.tsx', cues: [{ kind: 'alert' }] },
  // 管理ダッシュボードの成功の Toast を出す唯一の入口。
  { file: 'apps/dashboard-web/src/lib/action-feedback.ts', cues: [{ kind: 'toast' }] },
  { file: 'apps/store-detail/app/store/survey-settings/survey-settings-editor.tsx', cues: [{ kind: 'toast' }] },
  {
    // 店舗一覧の行に置く小さな文言。Alert の枠を行へ持ち込まないため、印を自前で添える。
    file: 'apps/dashboard-web/src/app/stores/store-suspension-control.tsx',
    cues: [
      {
        kind: 'own',
        verifiedBy: 'apps/dashboard-web/test/store-suspension-control.test.tsx',
        testTitle: '成功の文言には読み上げない成功の印が添えられ、結果の前の空の領域には印を置かない',
      },
    ],
  },
];

function sitesOf(kind: Cue['kind']): string[] {
  return SUCCESS_DISPLAYS.filter((entry) => entry.cues.some((cue) => cue.kind === kind)).map(
    (entry) => entry.file,
  );
}

/** そのファイルが属する面のルートレイアウト（App Router の app/layout.tsx）。 */
function rootLayoutOf(file: string): string {
  const app = file.split('/').slice(0, 2).join('/');
  const candidates = [`${app}/src/app/layout.tsx`, `${app}/app/layout.tsx`];
  const found = candidates.find((candidate) => existsSync(join(tsRoot, candidate)));
  if (found === undefined) throw new Error(`${app} のルートレイアウトが見つかりません`);
  return found;
}

/** 面のソース（.ts / .tsx / .css）を再帰的に列挙する。 */
function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSources(path);
    return /\.(?:tsx?|css)$/.test(name) ? [path] : [];
  });
}

function appSourceRoots(): string[] {
  return readdirSync(appsDir)
    .flatMap((app) => APP_SOURCE_DIRS.map((dir) => join(appsDir, app, dir)))
    .filter((root) => existsSync(root));
}

function filesWithSuccessSignals(): string[] {
  return appSourceRoots()
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

    it('src を持たない面（store-detail の app と lib）も走査している', () => {
      const roots = appSourceRoots().map((root) => relative(tsRoot, root).split('\\').join('/'));
      expect(roots).toEqual(expect.arrayContaining(['apps/store-detail/app', 'apps/store-detail/lib']));
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

  describe('Toast の印（共有部品の AppToaster）', () => {
    it('成功の Toast に読み上げないアイコンを渡し、失敗の Toast とは別の形にする', () => {
      render(<AppToaster />);
      const { icons } = toasterProps.mock.lastCall![0] as { icons: Record<string, ReactElement> };
      expect(icons.success, '成功の Toast にアイコンがありません').toBeDefined();
      const success = render(icons.success!).container.querySelector('svg');
      expect(success, '成功のアイコンが svg を描いていません').not.toBeNull();
      expect(success!.getAttribute('aria-hidden')).toBe('true');
      const error = render(icons.error!).container.querySelector('svg');
      expect(
        success!.querySelector('path')!.getAttribute('d'),
        '成功と失敗のアイコンが同じ形です。形の違いが状態を伝える手がかりの 1 つである',
      ).not.toBe(error!.querySelector('path')!.getAttribute('d'));
    });
  });

  it.each(sitesOf('toast'))('%s の成功の Toast は文言を持ち、面のレイアウトが AppToaster を置いている', (file) => {
    const source = readFileSync(join(tsRoot, file), 'utf8');
    const calls = [...source.matchAll(/\btoast\.success\(\s*([^)\s][^)]*)\)/g)];
    expect(calls.length, `${file} に成功の Toast が見つかりません`).toBeGreaterThan(0);
    for (const call of calls) {
      // 文言を渡す。空の文字列では、何が成功したかを伝えない。
      expect(call[1]!.trim(), `${file}: 成功の Toast に文言がありません`).not.toMatch(/^(['"`])\1/);
    }
    const layout = rootLayoutOf(file);
    expect(
      readFileSync(join(tsRoot, layout), 'utf8'),
      `${layout} が AppToaster を置いていません。Sonner の既定の Toaster では成功のアイコンが共有部品のものにならない`,
    ).toMatch(/<AppToaster\b/);
  });

  it.each(sitesOf('alert'))('%s の success 変種の Alert は文言を持つ', (file) => {
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
    entry.cues.flatMap((cue) => (cue.kind === 'own' ? [{ file: entry.file, ...cue }] : [])),
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

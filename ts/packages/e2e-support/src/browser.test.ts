import { describe, expect, it } from 'vitest';

import { chromiumLaunchOptions } from './browser';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

describe('chromiumLaunchOptions', () => {
  it('変数が指定されていれば、その実行ファイルで起動する', () => {
    expect(chromiumLaunchOptions({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: CHROME })).toEqual({
      launchOptions: { executablePath: CHROME, args: ['--disable-gpu'] },
    });
  });

  // 差し替えたブラウザは既定で GPU（SwiftShader）で描く。描き直すたびに濃淡や罫線の色が 1/255
  // 揺れ、画素差で測る検査（mobile-layout.spec.ts の R3）が散発的に落ちた（Issue #378）。
  it('差し替えるときは GPU を切り、付属 Chromium と同じソフトウェア描画に揃える', () => {
    expect(chromiumLaunchOptions({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: CHROME }).launchOptions?.args).toContain(
      '--disable-gpu',
    );
  });

  it('前後の空白は取り除く', () => {
    expect(chromiumLaunchOptions({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: ` ${CHROME}\n` })).toEqual({
      launchOptions: { executablePath: CHROME, args: ['--disable-gpu'] },
    });
  });

  it('CI では変数を無視して付属 Chromium を使う', () => {
    expect(
      chromiumLaunchOptions({ CI: 'true', PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: CHROME }),
    ).toEqual({});
  });

  it('未指定・空文字・空白のみなら差し替えない', () => {
    expect(chromiumLaunchOptions({})).toEqual({});
    expect(chromiumLaunchOptions({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '' })).toEqual({});
    expect(chromiumLaunchOptions({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '   ' })).toEqual({});
  });
});

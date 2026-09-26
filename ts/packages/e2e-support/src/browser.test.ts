import { describe, expect, it } from 'vitest';

import { chromiumLaunchOptions } from './browser';

const ASIDE = '/Applications/Aside.app/Contents/MacOS/Aside';

describe('chromiumLaunchOptions', () => {
  it('変数が指定されていれば、その実行ファイルで起動する', () => {
    expect(chromiumLaunchOptions({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: ASIDE })).toEqual({
      launchOptions: { executablePath: ASIDE },
    });
  });

  it('前後の空白は取り除く', () => {
    expect(chromiumLaunchOptions({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: ` ${ASIDE}\n` })).toEqual({
      launchOptions: { executablePath: ASIDE },
    });
  });

  it('CI では変数を無視して付属 Chromium を使う', () => {
    expect(
      chromiumLaunchOptions({ CI: 'true', PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: ASIDE }),
    ).toEqual({});
  });

  it('未指定・空文字・空白のみなら差し替えない', () => {
    expect(chromiumLaunchOptions({})).toEqual({});
    expect(chromiumLaunchOptions({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '' })).toEqual({});
    expect(chromiumLaunchOptions({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '   ' })).toEqual({});
  });
});

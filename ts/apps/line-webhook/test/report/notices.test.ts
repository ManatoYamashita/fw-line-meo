// 店舗なし・初回データ準備中・取得失敗の案内の試験（design.md「Report builders（表示）」の NoticeBuilders・
// Requirements 3.7, 3.8, 7.1, 7.2, 8.3）。
// - 3 つとも案内のテキストで、1 文 1 行・3 行以内・絵文字なし（design-language.md §7.16）
// - 店舗別の案内（準備中・取得失敗）のすべてに、省略しない店舗名が入ること
// - 取得失敗はデータ対象日を `M月D日` で添えること
// - 店舗なしは、代理店または運営へ確認する案内であること
// - 案内は Google Maps のデータを載せないので、帰属表示を付けないこと
import { describe, expect, it } from 'vitest';
import type { LineMessage } from '../../src/line/client.js';
import { buildFetchFailedNotice, buildNoStoreNotice, buildPreparingNotice } from '../../src/report/builders/notices.js';
import type { ReportContext } from '../../src/report/format.js';

function textOf(message: LineMessage): string {
  if (message.type !== 'text') {
    throw new Error(`text を期待したが ${message.type} だった`);
  }
  expect(message.quickReply).toBeUndefined();
  return message.text;
}

// 店舗名の例。長い名前（選択肢のラベルなら省略される長さ）・絵文字・記号を含む名前を混ぜる。
const STORE_NAMES: readonly string[] = [
  '試験食堂',
  '試験グループ運営のとても長い名前の焼肉店 渋谷道玄坂店',
  '試験カフェ \u{1F363} 二号店',
  '試験バル & ワイン「港」',
];

// 店舗別の案内の組立。店舗名が入ることを、案内ごとに同じ試験で確かめる。
const STORE_SPECIFIC_NOTICES: readonly [string, (ctx: ReportContext) => LineMessage][] = [
  ['初回データ準備中', (ctx) => buildPreparingNotice(ctx)],
  ['取得失敗', (ctx) => buildFetchFailedNotice(ctx, '2026-09-14')],
];

const ALL_NOTICES: readonly [string, () => LineMessage][] = [
  ['店舗なし', () => buildNoStoreNotice()],
  ...STORE_SPECIFIC_NOTICES.map(([name, build]): [string, () => LineMessage] => [name, () => build({ storeName: '試験食堂' })]),
];

describe('案内の書き方（design-language.md §7.16）', () => {
  it.each(ALL_NOTICES)('%s: テキストで 3 行以内、各行は 1 文、絵文字と強調の記号を使わない', (_name, build) => {
    const lines = textOf(build()).split('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) {
      expect(line.endsWith('。')).toBe(true);
      // 行の途中で文を終えていない（1 文 1 行）。
      expect(line.slice(0, -1)).not.toContain('。');
    }
    const text = lines.join('\n');
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toContain('**');
  });

  it.each(ALL_NOTICES)('%s: Google Maps のデータを載せないので、帰属表示を付けない', (_name, build) => {
    expect(textOf(build())).not.toContain('Google');
  });
});

describe('店舗別の案内のすべてに店舗名が入る（3.8）', () => {
  it.each(STORE_SPECIFIC_NOTICES)('%s: 省略しない店舗名を「」で括って入れる', (_name, build) => {
    for (const storeName of STORE_NAMES) {
      expect(textOf(build({ storeName }))).toContain(`「${storeName}」`);
    }
  });
});

describe('buildNoStoreNotice（3.7）', () => {
  it('利用できる店舗がない旨と、登録を担当した代理店または運営へ確認する案内を返す', () => {
    expect(textOf(buildNoStoreNotice())).toBe(
      'レポートを表示できる店舗がありません。\n店舗の登録を担当した代理店または運営にご確認ください。',
    );
  });
});

describe('buildPreparingNotice（7.1）', () => {
  it('店舗名を添えて、登録直後などの理由で初回のデータを準備している旨を返す', () => {
    expect(textOf(buildPreparingNotice({ storeName: '試験食堂' }))).toBe(
      '「試験食堂」の初回のデータを準備しています。\n' +
        '店舗の登録直後は、データがそろうまで時間がかかります。\n' +
        'しばらくしてから、もう一度お試しください。',
    );
  });
});

describe('buildFetchFailedNotice（7.2・8.3）', () => {
  it('店舗名とデータ対象日を添えて、最新のデータを取得できなかった旨と後で確認する案内を返す', () => {
    expect(textOf(buildFetchFailedNotice({ storeName: '試験食堂' }, '2026-09-14'))).toBe(
      '「試験食堂」の最新のデータ（9月14日分）を取得できませんでした。\n次のデータの更新の後に、もう一度ご確認ください。',
    );
  });

  it.each([
    ['2026-01-05', '1月5日分'],
    ['2026-12-31', '12月31日分'],
  ])('データ対象日 %s を %s と書く', (date, expected) => {
    expect(textOf(buildFetchFailedNotice({ storeName: '試験食堂' }, date))).toContain(`（${expected}）`);
  });

  it('データ対象日が暦日として正しくなければ例外にする（呼出元の誤りを黙って表示しない）', () => {
    expect(() => buildFetchFailedNotice({ storeName: '試験食堂' }, '2026-02-30')).toThrow();
  });
});

describe('スナップショット（LINE へ送る JSON の記録）', () => {
  it('店舗なし', () => {
    expect(buildNoStoreNotice()).toMatchSnapshot();
  });

  it('初回データ準備中', () => {
    expect(buildPreparingNotice({ storeName: '試験食堂 駅前店' })).toMatchSnapshot();
  });

  it('取得失敗', () => {
    expect(buildFetchFailedNotice({ storeName: '試験食堂 駅前店' }, '2026-09-14')).toMatchSnapshot();
  });
});

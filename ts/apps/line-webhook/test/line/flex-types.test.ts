import { describe, expect, expectTypeOf, it } from 'vitest';
import type { messagingApi } from '@line/bot-sdk';
import type { LineMessage } from '../../src/line/client.js';
import type {
  FlexAction,
  FlexBlockStyle,
  FlexBoxContent,
  FlexBubbleContents,
  FlexBubbleStyles,
  FlexCarouselContents,
  QuickReply,
  QuickReplyAction,
  QuickReplyItem,
} from '../../src/line/flex-types.js';

// Flex とクイックリプライの共有の型（src/line/flex-types.ts）の試験。
// Requirement 3.2: 複数店舗の選択肢は、テキストのメッセージに付けたクイックリプライで提示する。
//
// ここで確かめているのは型であり、vitest の実行では誤りを検出できない。赤くなるのは
// `pnpm --filter @fwlm/line-webhook run typecheck`（tsconfig.typecheck.json が test/ を含む）である。

// 引数の位置で LineMessage への代入を検査させる。代入できない形は、この呼び出しの中で型検査が落ちる。
function asLineMessage(message: LineMessage): LineMessage {
  return message;
}

describe('LineMessage のクイックリプライ', () => {
  it('テキストのメッセージは postback のクイックリプライを持てる', () => {
    const message = asLineMessage({
      type: 'text',
      text: 'テスト用の案内',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'postback', label: 'テスト食堂', data: 'data-1', displayText: 'テスト食堂' } },
          { type: 'action', action: { type: 'postback', label: 'ほかの店舗', data: 'data-2', displayText: 'ほかの店舗' } },
        ],
      },
    });

    expect(message.type === 'text' ? message.quickReply?.items : undefined).toHaveLength(2);
  });

  it('クイックリプライを持たないテキストのメッセージもそのまま書ける', () => {
    const message = asLineMessage({ type: 'text', text: 'テスト用の案内' });

    expect(message).toEqual({ type: 'text', text: 'テスト用の案内' });
  });

  // 以下は、LINE が必須とする項目を欠いた形と、この型が許していない形を並べる。
  // 一次情報は references/action-objects.md（postback は data が必須、クイックリプライのラベルは必須）
  // と references/message-objects.md（項目の type は action）である。
  // 期待どおりに型検査が落ちなければ、指示の行そのものが「使われていない」として型検査を落とす。
  it('postback の data を欠いた選択肢は書けない', () => {
    asLineMessage({
      type: 'text',
      text: 'テスト用の案内',
      quickReply: {
        items: [
          // @ts-expect-error postback の data は必須
          { type: 'action', action: { type: 'postback', label: 'テスト食堂', displayText: 'テスト食堂' } },
        ],
      },
    });
  });

  it('ラベルを欠いた選択肢は書けない', () => {
    asLineMessage({
      type: 'text',
      text: 'テスト用の案内',
      quickReply: {
        items: [
          // @ts-expect-error クイックリプライのラベルは必須
          { type: 'action', action: { type: 'postback', data: 'data-1', displayText: 'テスト食堂' } },
        ],
      },
    });
  });

  it('displayText を欠いた選択肢は書けない（選んだ店舗名をトークに残す）', () => {
    asLineMessage({
      type: 'text',
      text: 'テスト用の案内',
      quickReply: {
        items: [
          // @ts-expect-error displayText は選んだ店舗名をトークに表示するため必須にしている
          { type: 'action', action: { type: 'postback', label: 'テスト食堂', data: 'data-1' } },
        ],
      },
    });
  });

  it('postback 以外の action は選択肢に書けない', () => {
    asLineMessage({
      type: 'text',
      text: 'テスト用の案内',
      quickReply: {
        items: [
          // @ts-expect-error 選択肢は postback だけを使う
          { type: 'action', action: { type: 'uri', label: 'テスト食堂', uri: 'https://example.com/' } },
        ],
      },
    });
  });

  it('項目の type が action でないものは書けない', () => {
    asLineMessage({
      type: 'text',
      text: 'テスト用の案内',
      quickReply: {
        items: [
          // @ts-expect-error 項目の type は action に限られる
          { type: 'button', action: { type: 'postback', label: 'テスト食堂', data: 'data-1', displayText: 'テスト食堂' } },
        ],
      },
    });
  });
});

// 局所の型の鍵を @line/bot-sdk の生成型（一次情報）へ突き合わせる。
// 局所の型は、LINE が必須とする項目を必須として書くために手で持っている（生成型はほぼすべての項目を
// 省略可能にしている）。手で書く以上、綴りの誤った鍵は LINE に届くまで気づけないので、ここで落とす。
// 値の型は照合しない。局所の型は読み取り専用の配列を使い、生成型は可変の配列を使うためである。

// SDK に無い鍵を「名前.鍵」の文字列で返す。SDK に対応する型が無ければ名前そのものを返す。
type KeysAbsentFromSdk<Name extends string, Local, Sdk> = [Sdk] extends [never]
  ? `${Name}（SDK に同じ type が無い）`
  : `${Name}.${Exclude<keyof Local, keyof Sdk> & string}`;

// union の各要素を、判別子（type）が同じ SDK の型へ突き合わせる。union へ要素を足せば、足した型も自動で照合される。
type KeysAbsentFromSdkByType<Local extends { readonly type: string }, SdkUnion> = Local extends unknown
  ? KeysAbsentFromSdk<Local['type'], Local, Extract<SdkUnion, { type: Local['type'] }>>
  : never;

// 型引数が never でなければ型検査が落ちる。診断に違反した「名前.鍵」が出る
// （例: Type '"text.maxLine"' does not satisfy the constraint 'never'）。
type NoKeysAbsentFromSdk<Keys extends never> = Keys;

describe('局所の型と @line/bot-sdk の生成型', () => {
  it('局所の型が持つ鍵はすべて生成型に実在する', () => {
    expectTypeOf<
      NoKeysAbsentFromSdk<
        | KeysAbsentFromSdkByType<FlexBoxContent, messagingApi.FlexComponent>
        | KeysAbsentFromSdkByType<FlexBubbleContents | FlexCarouselContents, messagingApi.FlexContainer>
        | KeysAbsentFromSdkByType<FlexAction | QuickReplyAction, messagingApi.Action>
        | KeysAbsentFromSdkByType<LineMessage, messagingApi.Message>
        // 判別子を持たない型は、対応する生成型を名指しする。
        | KeysAbsentFromSdk<'FlexBubbleStyles', FlexBubbleStyles, messagingApi.FlexBubbleStyles>
        | KeysAbsentFromSdk<'FlexBlockStyle', FlexBlockStyle, messagingApi.FlexBlockStyle>
        | KeysAbsentFromSdk<'QuickReply', QuickReply, messagingApi.QuickReply>
        | KeysAbsentFromSdk<'QuickReplyItem', QuickReplyItem, messagingApi.QuickReplyItem>
      >
    >().toEqualTypeOf<never>();
  });
});

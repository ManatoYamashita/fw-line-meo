// Google 認可（OAuth）コールバックの受け口（gbp-post-review-reply spec task 3.2・CallbackRoute）。
// Requirements: 1.4（認可完了の通知と機能解禁）, 1.5（拒否・中断の案内）, 1.6（管理権限なしの案内）。
//
// 責務は「GbpOauthService の結果 → ブラウザへ返す最小 HTML ＋ オーナーへの LINE Push」への変換のみ。
// 認可の判断（state 照合・code 交換・突合・永続化）は一切ここで行わない（oauth.ts の所有）。
//
// 設計上の不変条件:
// - **認可コード・state を HTML にもログにも出さない**（Req 2.1）。callback の URL には両者が
//   載るため、本モジュールは受け取った生値を結果へ持ち出さない（handleOauthCallback へ渡すのみ）。
// - HTML へ埋め込む値（店舗名）は必ずエスケープする。埋め込み口は `page()` の 1 箇所に閉じ、
//   文字列連結で HTML を組む他の経路を作らない。
// - **Push はベストエフォート**。通知先が解決できない・LINE が失敗しても callback の HTTP 応答は
//   落とさない（ブラウザ側の HTML が最後の伝達手段になるため、案内は HTML 側にも必ず含める）。
// - 応答ステータスは design「API Contract」に従う: 200（結果の提示）/ 400（state 不正）/ 500（内部失敗）。

import type { Queryable } from '@fwlm/db';
import { colors } from '@fwlm/design-tokens';
import type { LineMessage } from '../line/client.js';
import type { FlexBubbleContents } from '../line/messages.js';
import { encodeGbpPostback } from './postback.js';
import type { GbpOauthService, OauthCallbackResult } from './oauth.js';

/** LINE Push の最小面（LineMessenger の `push` のみを要求する）。 */
export interface GbpCallbackNotifier {
  push(lineUserId: string, messages: readonly LineMessage[]): Promise<void>;
}

/**
 * 通知先（LINE userId）の解決に必要な最小面。
 * `@fwlm/db` の `findOwnerById`（OwnerRow を返す）をそのまま渡せるよう行の列名で受ける。
 */
export interface GbpCallbackOwnerLookup {
  findOwnerById(db: Queryable, ownerId: string): Promise<{ line_user_id: string } | null>;
}

export interface GbpCallbackLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface GbpOauthCallbackDeps {
  db: Queryable;
  oauth: Pick<GbpOauthService, 'handleOauthCallback'>;
  messenger: GbpCallbackNotifier;
  owners: GbpCallbackOwnerLookup;
  logger: GbpCallbackLogger;
}

export interface GbpCallbackResponse {
  /** design「API Contract」: 200 HTML / 400（state 不正）/ 500。 */
  status: 200 | 400 | 500;
  html: string;
}

export type GbpOauthCallbackRoute = (params: {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
}) => Promise<GbpCallbackResponse>;

// =====================================================================
// HTML（スマホブラウザ向けの最小ページ）
// =====================================================================

/** HTML テキスト・属性値の双方で安全になる最小エスケープ。 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * 唯一の HTML 組み立て口。可変値は必ずここでエスケープされるため、
 * 呼び出し側がエスケープ漏れを起こす余地を作らない。
 */
function page(input: { title: string; heading: string; lines: readonly string[] }): string {
  const body = input.lines
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('\n      ');

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      body { font-family: system-ui, -apple-system, "Hiragino Sans", sans-serif; margin: 0; padding: 24px; line-height: 1.7; color: ${colors.text}; background: ${colors.background}; }
      main { max-width: 480px; margin: 0 auto; }
      h1 { font-size: 1.25rem; margin: 0 0 16px; }
      p { margin: 0 0 12px; font-size: 0.95rem; }
      .note { color: ${colors.textMuted}; font-size: 0.85rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(input.heading)}</h1>
      ${body}
      <p class="note">この画面は閉じていただいて構いません。</p>
    </main>
  </body>
</html>
`;
}

const BACK_TO_LINE = 'LINE のトーク画面に戻ってご確認ください。';

function linkedPage(storeName: string): string {
  return page({
    title: 'Google 連携が完了しました',
    heading: 'Google 連携が完了しました',
    lines: [
      `「${storeName}」の Google ビジネスプロフィールとの連携が完了しました。`,
      'これから Google 投稿の作成とクチコミ返信が LINE から使えます。',
      BACK_TO_LINE,
    ],
  });
}

function deniedPage(): string {
  return page({
    title: 'Google 連携は完了していません',
    heading: 'Google 連携は完了していません',
    lines: [
      '認可の手続きが取り消されたため、連携は完了していません。',
      'もう一度やり直す場合は、LINE のトーク画面から「Google 連携」をやり直してください。',
      BACK_TO_LINE,
    ],
  });
}

function stateMismatchPage(): string {
  return page({
    title: '手続きの有効期限が切れました',
    heading: '手続きの有効期限が切れました',
    lines: [
      '認可の手続きが確認できませんでした（有効期限切れ、または手続きが重複した可能性があります）。',
      'お手数ですが、LINE のトーク画面から最初からやり直してください。',
    ],
  });
}

function noPermissionPage(): string {
  return page({
    title: 'Google 連携は完了していません',
    heading: 'Google 連携は完了していません',
    lines: [
      '認可された Google アカウントに、この店舗のビジネスプロフィールの管理権限がありませんでした。',
      '管理権限のある Google アカウントで、もう一度連携をやり直してください。',
      BACK_TO_LINE,
    ],
  });
}

function errorPage(): string {
  return page({
    title: 'Google 連携を完了できませんでした',
    heading: 'Google 連携を完了できませんでした',
    lines: [
      '一時的な問題により、連携を完了できませんでした。時間をおいてもう一度お試しください。',
      BACK_TO_LINE,
    ],
  });
}

// =====================================================================
// LINE 通知メッセージ（表示専用・純粋関数）
// =====================================================================

/** 再連携（g_connect）へ戻す 1 ボタンのバブル。文言以外の構造は 3 通知で共通。 */
function retryBubble(input: { heading: string; body: string; buttonLabel: string }): FlexBubbleContents {
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: input.heading, weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: input.body, size: 'sm', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          action: {
            type: 'postback',
            label: input.buttonLabel,
            data: encodeGbpPostback({ action: 'g_connect' }),
            displayText: input.buttonLabel,
          },
        },
      ],
    },
  };
}

/** Req 1.4: 連携完了と、その店舗で投稿・返信が使えるようになったことの通知。 */
export function buildGbpLinkCompletedMessage(storeName: string): LineMessage {
  return {
    type: 'text',
    text:
      `「${storeName}」の Google 連携が完了しました。\n` +
      'これから Google 投稿の作成とクチコミ返信がこのトークから使えます。',
  };
}

/** Req 1.5: 認可の拒否・中断と、再試行の手段の案内。 */
export function buildGbpLinkDeniedMessage(): LineMessage {
  return {
    type: 'flex',
    altText: 'Google 連携は完了していません。もう一度お試しください。',
    contents: retryBubble({
      heading: 'Google 連携は完了していません',
      body: '認可の手続きが取り消されました。もう一度やり直す場合は下のボタンから開始してください。',
      buttonLabel: '連携をやり直す',
    }),
  };
}

/** Req 1.6: 管理権限のあるアカウントでの再連携の案内（連携は成立していない）。 */
export function buildGbpLinkNoPermissionMessage(): LineMessage {
  return {
    type: 'flex',
    altText: 'Google 連携は完了していません。管理権限のあるアカウントでやり直してください。',
    contents: retryBubble({
      heading: 'Google 連携は完了していません',
      body: '認可された Google アカウントに、この店舗のビジネスプロフィールの管理権限がありませんでした。管理権限のあるアカウントでやり直してください。',
      buttonLabel: '別のアカウントで連携する',
    }),
  };
}

/**
 * 内部失敗時の通知。**「管理権限がない」「再連携が必要」と断定しない**（誤誘導を避ける）。
 * 一過性障害として時間をおいた再試行だけを案内する。
 */
export function buildGbpLinkErrorMessage(): LineMessage {
  return {
    type: 'flex',
    altText: 'Google 連携を完了できませんでした。時間をおいてお試しください。',
    contents: retryBubble({
      heading: 'Google 連携を完了できませんでした',
      body: '一時的な問題が発生しました。お手数ですが、時間をおいてもう一度お試しください。',
      buttonLabel: 'もう一度試す',
    }),
  };
}

// =====================================================================
// ルートハンドラ
// =====================================================================

/** 結果 → （HTTP 応答, 通知先, 通知メッセージ）の対応表。ここが 4 経路の唯一の分岐点。 */
function planFor(result: OauthCallbackResult): {
  response: GbpCallbackResponse;
  ownerId: string | null;
  message: LineMessage | null;
} {
  switch (result.kind) {
    case 'linked':
      return {
        response: { status: 200, html: linkedPage(result.storeName) },
        ownerId: result.ownerId,
        message: buildGbpLinkCompletedMessage(result.storeName),
      };
    case 'denied':
      return {
        response: { status: 200, html: deniedPage() },
        ownerId: result.ownerId,
        message: buildGbpLinkDeniedMessage(),
      };
    case 'state_mismatch':
      // 通知先を解決する手段が無い（state が照合できていない）。HTML が唯一の伝達手段。
      return { response: { status: 400, html: stateMismatchPage() }, ownerId: null, message: null };
    case 'no_permission':
      return {
        response: { status: 200, html: noPermissionPage() },
        ownerId: result.ownerId,
        message: buildGbpLinkNoPermissionMessage(),
      };
    case 'error':
      return {
        response: { status: 500, html: errorPage() },
        ownerId: result.ownerId,
        message: buildGbpLinkErrorMessage(),
      };
  }
}

export function createGbpOauthCallbackRoute(deps: GbpOauthCallbackDeps): GbpOauthCallbackRoute {
  /**
   * 結果の本通知（Req 1.4・1.5・1.6）。**失敗しても throw しない**。
   * ログには結果種別と ownerId しか載せない（認可コード・state・トークンは持ち込まない）。
   */
  async function notify(input: {
    kind: OauthCallbackResult['kind'];
    ownerId: string | null;
    message: LineMessage | null;
  }): Promise<void> {
    if (input.message === null) return;
    if (input.ownerId === null) {
      // state が照合できず owner を特定できなかった場合。HTML 側の案内のみが届く。
      deps.logger.warn('gbp oauth callback: owner unknown; push notification skipped', {
        kind: input.kind,
      });
      return;
    }

    try {
      const owner = await deps.owners.findOwnerById(deps.db, input.ownerId);
      if (owner === null) {
        deps.logger.warn('gbp oauth callback: owner not found; push notification skipped', {
          kind: input.kind,
          ownerId: input.ownerId,
        });
        return;
      }
      await deps.messenger.push(owner.line_user_id, [input.message]);
    } catch (err) {
      // Push・owner 参照の失敗で callback を落とさない（HTML は必ず返す）。
      deps.logger.warn('gbp oauth callback: push notification failed', {
        kind: input.kind,
        ownerId: input.ownerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return async function handleGbpOauthCallback(params) {
    let result: OauthCallbackResult;
    try {
      result = await deps.oauth.handleOauthCallback(params);
    } catch (err) {
      // handleOauthCallback は結果型で失敗を表す契約だが、想定外の例外でも 500 HTML を返す。
      // 原因文字列は認可コードを含みうる（google-auth-library の GaxiosError 由来）ため記録しない。
      deps.logger.error('gbp oauth callback: unexpected failure while handling callback', {
        errorType: err instanceof Error ? err.name : typeof err,
      });
      return { status: 500, html: errorPage() };
    }

    const plan = planFor(result);
    await notify({ kind: result.kind, ownerId: plan.ownerId, message: plan.message });
    return plan.response;
  };
}

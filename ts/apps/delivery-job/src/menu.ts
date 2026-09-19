// 完了後メニューの準備判定とオーナーの照合（design.md「ReportMenuGate」・Requirements 1.10, 2.8）。
//
// 通知はオーナーを「メニューの該当導線」へ誘導する。したがって送る前に 2 つを保証する必要がある。
//   1. 設定された完了後メニュー（LINE_RICHMENU_COMPLETED_ID）がレポート 3 導線を持つこと
//   2. そのオーナーが、そのメニューを見ていること
// どちらも満たせない相手には送らない（呼出元が status `skipped_menu_unavailable` で記録する）。
// 押しても答えの返らない導線へ誘導するくらいなら、その日は送らない方がよい。
//
// 3 導線を持つかの判定は `@fwlm/line-report` の `exposesAllReportActions` だけを使う。ここで判定を
// 作り直すと、メニューの区画の data の形（店舗つき・頁つきの data は区画ではない）が 2 か所に分かれ、
// 片方だけが postback の形式変更に追従しうる。判定はメニューを張り替えるスクリプトとも共有する。
//
// 照会は実行ごとに 1 回だけ行い、結果を実行の中で使い回す。対象が 1 件も無い実行でも準備判定は行う
// （実行サマリーの `reportMenuReady` に出すため。呼び出しの順序は編成の側の責務）。
//
// 記録（ログ）には LINE ユーザー ID と店舗 ID を載せない。載せるのは失敗の要約（リテラル）と
// 例外の種別だけである。

import { exposesAllReportActions, type RichMenuActionLike } from '@fwlm/line-report';
import type { LogFields } from '@fwlm/observability';

import type { UserRichMenuLookup } from './line.js';

/** 設定された完了後メニューが、レポート 3 導線を持つか。 */
export type MenuReadiness = 'ready' | 'not_ready';

/** オーナーが完了後メニューを見ている状態にできたか。 */
export type OwnerMenuOutcome = 'already_linked' | 'linked' | 'link_failed';

/**
 * 判定に要る LINE の呼出だけを宣言する（実体は LineClient）。Push を含めないのは、この門が
 * 通知そのものを送らないためである。
 */
export interface ReportMenuLineClient {
  getRichMenuActions(accessToken: string, richMenuId: string): Promise<RichMenuActionLike[] | null>;
  getUserRichMenuId(accessToken: string, lineUserId: string): Promise<UserRichMenuLookup>;
  linkUserRichMenu(accessToken: string, lineUserId: string, richMenuId: string): Promise<boolean>;
}

/**
 * 記録の手段。編成（index.ts）の DeliveryJobLogger をそのまま渡せるよう、要る形だけを宣言する
 * （line-webhook の CompletedMenuLogger と同じ考え方で、編成へ依存しないため）。
 */
export interface ReportMenuLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

export interface ReportMenuGate {
  /** 設定された完了後メニューの準備判定。実行ごとに 1 回だけ照会し、以後は同じ結果を返す。 */
  checkReady(accessToken: string): Promise<MenuReadiness>;
  /** オーナーのメニューを完了後メニューに揃える。実行の中でオーナーごとに結果を覚える。 */
  ensureOwner(accessToken: string, lineUserId: string): Promise<OwnerMenuOutcome>;
}

export interface ReportMenuGateDeps {
  readonly lineClient: ReportMenuLineClient;
  /** 設定された完了後メニューの ID（env LINE_RICHMENU_COMPLETED_ID）。 */
  readonly completedRichMenuId: string;
  readonly logger: ReportMenuLogger;
}

/** 例外の種別だけを取り出す。本文は記録しない（接続情報や入力値が混ざりうるため）。 */
function errorKindOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'UnknownError';
}

/** 呼出の結果か、例外の種別か。例外を値へ変換して、失敗を握り潰さずに分岐へ落とす。 */
type CallOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errorKind: string };

async function callOrErrorKind<T>(run: () => Promise<T>): Promise<CallOutcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    return { ok: false, errorKind: errorKindOf(err) };
  }
}

export function createReportMenuGate(deps: ReportMenuGateDeps): ReportMenuGate {
  // 実行ごとに 1 回だけ照会するため、**解決済みの値ではなく約束を覚える**。値を覚えると、
  // 最初の照会が終わる前の 2 回目の呼出が 2 本目の照会を出してしまう。
  let readiness: Promise<MenuReadiness> | null = null;
  const owners = new Map<string, Promise<OwnerMenuOutcome>>();

  async function resolveReadiness(accessToken: string): Promise<MenuReadiness> {
    const outcome = await callOrErrorKind(() =>
      deps.lineClient.getRichMenuActions(accessToken, deps.completedRichMenuId),
    );

    if (!outcome.ok) {
      deps.logger.warn('delivery-job.report_menu_not_ready', {
        detail: 'rich menu lookup failed',
        errorKind: outcome.errorKind,
      });
      return 'not_ready';
    }
    if (outcome.value === null) {
      deps.logger.warn('delivery-job.report_menu_not_ready', { detail: 'rich menu lookup failed' });
      return 'not_ready';
    }
    if (!exposesAllReportActions(outcome.value)) {
      deps.logger.warn('delivery-job.report_menu_not_ready', { detail: 'report actions missing' });
      return 'not_ready';
    }
    return 'ready';
  }

  async function resolveOwner(accessToken: string, lineUserId: string): Promise<OwnerMenuOutcome> {
    const lookup = await callOrErrorKind(() => deps.lineClient.getUserRichMenuId(accessToken, lineUserId));

    if (!lookup.ok) {
      deps.logger.warn('delivery-job.richmenu_link_failed', {
        detail: 'user menu lookup failed',
        errorKind: lookup.errorKind,
      });
      return 'link_failed';
    }
    if (lookup.value.kind === 'linked' && lookup.value.richMenuId === deps.completedRichMenuId) {
      return 'already_linked';
    }
    if (lookup.value.kind === 'lookup_failed') {
      // 照会できなかった状態を「同じメニューを見ている」とみなすと、導線の無いメニューのまま誘導する。
      deps.logger.warn('delivery-job.richmenu_link_failed', { detail: 'user menu lookup failed' });
      return 'link_failed';
    }

    // 個別のリンクが無い（404）か、別のメニューを見ている。どちらも張り直す対象である。
    const linked = await callOrErrorKind(() =>
      deps.lineClient.linkUserRichMenu(accessToken, lineUserId, deps.completedRichMenuId),
    );

    if (!linked.ok) {
      deps.logger.warn('delivery-job.richmenu_link_failed', {
        detail: 'link request failed',
        errorKind: linked.errorKind,
      });
      return 'link_failed';
    }
    if (!linked.value) {
      deps.logger.warn('delivery-job.richmenu_link_failed', { detail: 'link request failed' });
      return 'link_failed';
    }

    // 成功も記録する。失敗だけを記録すると「記録が無い」が成功と未実行のどちらか判定できない。
    deps.logger.info('delivery-job.richmenu_linked');
    return 'linked';
  }

  return {
    checkReady(accessToken) {
      if (readiness === null) {
        readiness = resolveReadiness(accessToken);
      }
      return readiness;
    },
    ensureOwner(accessToken, lineUserId) {
      const remembered = owners.get(lineUserId);
      if (remembered !== undefined) {
        return remembered;
      }
      const pending = resolveOwner(accessToken, lineUserId);
      owners.set(lineUserId, pending);
      return pending;
    },
  };
}

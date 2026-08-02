// /api/detail の応答契約（Issue #61・task 5.4）。
//
// app/api/detail/route.ts（サーバー）と app/store/page.tsx（クライアント）の両方が参照する。
// エラーコード文字列を 1 箇所に固定し、サーバーとクライアントで綴りがドリフトするのを防ぐ。
//
// ⚠️ このファイルはクライアントバンドルに取り込まれる。`@fwlm/db` からの取り込みは必ず
//    `import type` に限ること（tsconfig は isolatedModules: true）。値 import を 1 つでも
//    書くと pg / cloud-sql-connector が Node 専用依存ごとクライアントへ引きずり込まれる。

import type { StoreDetailResult } from './data';

/**
 * 認可済み集合の 1 要素をクライアントへ開示する形。
 *
 * 開示するのは表示と選択に必要な最小限（storeId と店舗名）のみで、place_id・座標・owner_id は
 * 含めない。要求元 sub が所有する店舗に限られるため、この 2 項目の開示は情報漏洩にならない。
 */
export interface StoreRef {
  readonly storeId: string;
  readonly name: string;
}

/**
 * 表示対象が確定したときの 200 応答。
 *
 * `stores` は認可済み集合の全体（1 件のこともある）。画面はこの長さで「店舗を切り替える」導線の
 * 要否を判断する。`storeName` は表示中の店舗名（要件 4.7）。
 */
export interface StoreDetailResponse extends StoreDetailResult {
  readonly storeName: string;
  readonly stores: readonly StoreRef[];
}

/**
 * 認可済み集合が 2 件以上あり、ヒントでも表示対象を決められないときのエラーコード。
 *
 * 409 で返す（表示対象が一意に決まらないという要求と状態の衝突であり、404「存在しない」でも
 * 401「認可されていない」でもない）。本文には候補一覧を含めるが、詳細データは一切含めない
 * ＝ どちらかの店舗を推測で表示しないことの担保。
 */
export const STORE_SELECTION_REQUIRED = 'STORE_SELECTION_REQUIRED';

/** 409 応答の本文形状。 */
export interface StoreSelectionRequiredBody {
  readonly error: {
    readonly code: typeof STORE_SELECTION_REQUIRED;
    readonly message: string;
  };
  readonly stores: readonly StoreRef[];
}

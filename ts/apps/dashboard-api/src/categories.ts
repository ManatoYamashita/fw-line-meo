import { authenticate, type AuthDeps } from './auth.js';
import { jsonError } from './http.js';

// GET /categories の中核ロジック（依存注入でテスト可能・ルート配線は app 側の責務）。
// 店舗登録ウィザードのカテゴリ選択用（Req 3.7）。認証（ロール不問）→ 一覧取得 → 封筒化。
// カテゴリの単一情報源は DB seed（listCategories 経由）であり、コード内に定義を二重化しない。

export interface CategoryItem {
  code: string;
  label: string;
}

export interface CategoriesDeps {
  auth: AuthDeps;
  // listCategories（@fwlm/db）を部分適用した一覧取得（code 昇順）。
  listCategories: () => Promise<CategoryItem[]>;
}

export interface CategoriesRequest {
  authorization: string | undefined;
}

export async function handleCategories(
  deps: CategoriesDeps,
  req: CategoriesRequest,
): Promise<Response> {
  // 1. 認証（Bearer 検証 → 利用者解決）。operator/agency のどちらでも閲覧可（スコープ不要の参照データ）。
  const auth = await authenticate(deps.auth, req.authorization);
  if (auth.kind === 'unauthenticated') {
    return jsonError(401, 'unauthenticated', 'ログインが必要です');
  }
  if (auth.kind === 'unregistered' || auth.kind === 'disabled') {
    // 未登録・無効化はいずれもアクセス権なし（403）。存在有無を漏らさない同一封筒。
    return jsonError(403, 'forbidden', 'アクセス権がありません');
  }

  // 2. カテゴリ一覧取得（参照データ・テナント絞り込み不要）。
  const categories = await deps.listCategories();

  return new Response(JSON.stringify({ categories }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

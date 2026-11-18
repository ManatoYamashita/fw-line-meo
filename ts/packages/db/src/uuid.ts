// UUID の形の判定（大文字・小文字を問わない）。形でない id は DB へ問い合わせずに not-found として扱う。
// uuid 型への変換で SQL が失敗するのを避けるためと、無効な URL をエラーページへ回すため（survey Req 2.7）。
// stores.ts と owners.ts で同じ判定を使うため、ここに 1 か所だけ置く。
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 一括発信（line-crosspost）の実行時設定。**既定 OFF**（Req 10.1）。
//
// - CROSSPOST_PILOT_STORE_IDS: 本機能を見せる店舗の ID（UUID・カンマ区切り）。これが本機能の有効化の唯一の入口で、
//   無ければ何も組み立てない（会話からの委譲・画像の正規化を一切行わない・Req 10.3）。
// - CROSSPOST_MEDIA_BUCKET: 写真の置き場（非公開の GCS バケット）。有効にするなら必須。
// - CROSSPOST_GOOGLE_ENABLED: Google への投稿を有効にするか（"1" のときだけ）。本機能の有効化とは分ける（Req 10.2）。
//   GBP の連携（gbp-post-review-reply）が OFF なら、ここを "1" にしても Google は「準備中」のまま。
//
// **一部だけあるときは起動時に落とす**（Req 10.4）。入れ忘れを黙って OFF にすると、有効にしたつもりの運用者が
// 原因を辿れない（GBP の設定の読み込みと同じ規律）。

export interface CrosspostConfig {
  pilotStoreIds: readonly string[];
  mediaBucket: string;
  googleEnabled: boolean;
}

/** 本機能を有効にする env。全部あるか、全部無いかのどちらかでなければならない。 */
export const CROSSPOST_ENV_KEYS = ['CROSSPOST_PILOT_STORE_IDS', 'CROSSPOST_MEDIA_BUCKET'] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// GCS のバケット名の形（小文字・数字・-_.・3〜63 字）。形の誤りを起動時に見つけるための確認で、実在は確かめない。
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

export function loadCrosspostConfig(env: NodeJS.ProcessEnv): CrosspostConfig | null {
  const present = CROSSPOST_ENV_KEYS.filter((key) => Boolean(env[key]?.trim()));
  if (present.length === 0) {
    if (env.CROSSPOST_GOOGLE_ENABLED === '1') {
      throw new Error('CROSSPOST_GOOGLE_ENABLED は一括発信を有効にしたときだけ設定できます（CROSSPOST_PILOT_STORE_IDS が無い）');
    }
    return null;
  }
  const missing = CROSSPOST_ENV_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `一括発信の env が一部だけ設定されています（不足: ${missing.join(', ')}）。有効にするなら全部、無効にするなら全部外してください`,
    );
  }

  const pilotStoreIds = [
    ...new Set(
      (env.CROSSPOST_PILOT_STORE_IDS ?? '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  ];
  const invalid = pilotStoreIds.filter((value) => !UUID_PATTERN.test(value));
  if (pilotStoreIds.length === 0 || invalid.length > 0) {
    throw new Error('CROSSPOST_PILOT_STORE_IDS は店舗 ID（UUID）のカンマ区切りで指定してください');
  }

  const mediaBucket = (env.CROSSPOST_MEDIA_BUCKET ?? '').trim();
  if (!BUCKET_PATTERN.test(mediaBucket)) {
    throw new Error('CROSSPOST_MEDIA_BUCKET の形が GCS のバケット名ではありません');
  }

  // 投稿文の生成に使う（survey-web・GBP と共有の secret）。有効にするときだけ要求する。
  if (!env.GEMINI_API_KEY?.trim()) {
    throw new Error('一括発信を有効にするには GEMINI_API_KEY の設定が要ります（投稿文の生成に使う）');
  }

  const googleFlag = env.CROSSPOST_GOOGLE_ENABLED;
  if (googleFlag !== undefined && googleFlag !== '' && googleFlag !== '0' && googleFlag !== '1') {
    throw new Error('CROSSPOST_GOOGLE_ENABLED は "1" か "0" で指定してください');
  }

  return { pilotStoreIds, mediaBucket, googleEnabled: googleFlag === '1' };
}

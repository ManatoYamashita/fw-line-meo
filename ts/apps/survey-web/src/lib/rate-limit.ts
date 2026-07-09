// 公開エンドポイントの生成コスト濫用に対する簡易レート制限（固定ウィンドウ）。
// ベストエフォート: ゼロスケール・複数インスタンス前提のため完全防御は狙わず、
// インスタンス内メモリで敷居を上げる。/api/responses と /api/drafts が共有する。

interface Bucket {
  count: number;
  resetAt: number; // epoch ms
}

export interface RateLimiterOptions {
  limit: number; // ウィンドウ内で許可する最大回数
  windowMs: number; // ウィンドウ長（ミリ秒）
  now?: () => number; // テスト用に注入可能
}

export interface RateLimiter {
  /** key（IP 等）が許可されれば true、上限超過なら false。 */
  check(key: string): boolean;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();

  return {
    check(key) {
      const t = now();
      const bucket = buckets.get(key);
      if (bucket === undefined || t >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      if (bucket.count >= limit) return false;
      bucket.count += 1;
      return true;
    },
  };
}

// 写真の置き場の GCS 実装（JSON API を直接呼ぶ。新しい SDK の依存を足さない）。
//
// - 認証は実行環境の既定の資格情報（Cloud Run のサービスアカウント）。google-auth-library は line-webhook の既存の依存。
// - バケットは非公開（均一なバケットレベルのアクセス・公開の付与なし）で、寿命の規則（7 日）を持つ前提。
//   Terraform は別 PR（tasks 6.1）。この実装はバケットの設定を変えない。
// - 取得用の URL は発行しない（canIssueFetchUrl = false・tasks 6.2）。
// - 失敗の詳細（応答本文・URL）は例外に載せない。名前と HTTP ステータスだけ。

import { GoogleAuth } from 'google-auth-library';
import type { MediaStore } from './media.js';

const UPLOAD_BASE = 'https://storage.googleapis.com/upload/storage/v1/b';
const OBJECT_BASE = 'https://storage.googleapis.com/storage/v1/b';
const SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const REQUEST_TIMEOUT_MS = 10_000;
// 置き場の名前の形（推測できない UUID を呼び出し側が作る）。パスの組み立ての前に確かめる。
const KEY_PATTERN = /^crosspost\/[0-9a-f-]{36}\.jpg$/;

export class MediaStoreError extends Error {
  constructor(
    readonly operation: 'put' | 'delete' | 'auth',
    readonly status: number,
  ) {
    super(`MediaStore ${operation} failed (status ${status})`);
    this.name = 'MediaStoreError';
  }
}

export interface GcsMediaStoreDeps {
  bucket: string;
  fetch: typeof fetch;
  /** アクセストークンの取得（テストで差し替える）。 */
  getAccessToken?: () => Promise<string>;
  requestTimeoutMs?: number;
}

export function isMediaStorageKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function createGcsMediaStore(deps: GcsMediaStoreDeps): MediaStore {
  const auth = deps.getAccessToken ? null : new GoogleAuth({ scopes: [SCOPE] });
  const timeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  async function accessToken(): Promise<string> {
    if (deps.getAccessToken) return deps.getAccessToken();
    const token = await auth!.getAccessToken();
    if (!token) throw new MediaStoreError('auth', 0);
    return token;
  }

  async function send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await deps.fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    canIssueFetchUrl: false,

    async put({ key, bytes, contentType }) {
      if (!isMediaStorageKey(key)) throw new MediaStoreError('put', 0);
      const token = await accessToken();
      // ifGenerationMatch=0: 同じ名前が既にあれば上書きしない（推測できない名前なので通常は衝突しない）。
      const url = `${UPLOAD_BASE}/${encodeURIComponent(deps.bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(key)}`;
      const response = await send(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
        body: new Uint8Array(bytes),
      });
      if (!response.ok) throw new MediaStoreError('put', response.status);
    },

    async delete(key) {
      if (!isMediaStorageKey(key)) throw new MediaStoreError('delete', 0);
      const token = await accessToken();
      const url = `${OBJECT_BASE}/${encodeURIComponent(deps.bucket)}/o/${encodeURIComponent(key)}`;
      const response = await send(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok && response.status !== 404) throw new MediaStoreError('delete', response.status);
    },

    async issueFetchUrl() {
      return null;
    },
  };
}

// LINE で送られた写真の取り込み（line-crosspost design.md「media / intake」・Requirement 2.1, 2.5, 2.6, 8.2, 8.6）。
//
// 取得（Content API）→ 検証と正規化（メタデータの除去）→ 置き場へ保存 → 下書きへ付ける（DB）。
// - 保存は推測できない名前（UUID）で行う。DB へ付けられなかったとき（作成中でない・同じ写真の再配信）は、
//   保存した実体をすぐ消す（孤立した実体を残さない。消せなくても置き場の寿命の規則が消す）。
// - 差し替えた古い写真の実体は、DB の更新の後に消す。
// - 写真の中身・URL・LINE の応答本文はログに出さない。

import { randomUUID } from 'node:crypto';
import type { CrosspostDraftRow, TransactionCapable } from '@fwlm/db';
import { attachCrosspostMedia } from '@fwlm/db';
import type { MessageContentResult } from '../line/client.js';
import { DRAFT_TTL_MS } from './domain.js';
import { errorNameOf, type CrosspostLogger } from './logger.js';
import { MAX_INPUT_BYTES, normalizeImage, type ImageRejection, type MediaStore } from './media.js';

export type IntakeRejection =
  | ImageRejection
  /** 取り消された・保存期間を過ぎた（もう取得できない）。 */
  | 'gone'
  /** LINE 以外の場所にある画像（contentProvider が external）。Content API では取得できない。 */
  | 'external'
  /** 取得・保存の一時的な失敗。 */
  | 'temporary'
  /** 送った時刻が分からない（写真の順序を判定できないので、推測で採用しない）。 */
  | 'unordered';

export type IntakeResult =
  | { kind: 'attached'; draft: CrosspostDraftRow; replaced: boolean }
  | { kind: 'duplicate' }
  /** 下書きを始める前・同じ時刻に送られた写真（別の下書きの写真が遅れて届いた可能性）。使わない。 */
  | { kind: 'before_draft' }
  /** いまの写真より前に送られた写真（処理が遅れて後から届いた）。使わない。 */
  | { kind: 'older' }
  /** いまの写真と同じ時刻に送られた別の写真。どちらが後か決められないので使わない。 */
  | { kind: 'ambiguous' }
  | { kind: 'not_open' }
  | { kind: 'rejected'; reason: IntakeRejection };

export interface PhotoIntakeDeps {
  pool: TransactionCapable;
  mediaStore: MediaStore;
  fetchContent: (messageId: string, maxBytes: number) => Promise<MessageContentResult>;
  logger: CrosspostLogger;
  now?: () => Date;
  newKey?: () => string;
}

export interface PhotoIntake {
  receive(input: {
    ownerId: string;
    draftId: string;
    messageId: string;
    contentProvider: 'line' | 'external';
    quoteToken: string | null;
    /** 店主が送った時刻（Webhook のイベントの timestamp・UNIX ミリ秒）。 */
    sentAt: number | null;
  }): Promise<IntakeResult>;
}

export function createPhotoIntake(deps: PhotoIntakeDeps): PhotoIntake {
  const now = deps.now ?? (() => new Date());
  const newKey = deps.newKey ?? (() => `crosspost/${randomUUID()}.jpg`);

  async function deleteQuietly(key: string, ownerId: string): Promise<void> {
    try {
      await deps.mediaStore.delete(key);
    } catch (error) {
      deps.logger.warn('crosspost.media_cleanup_failed', { ownerId, operation: 'intake', errorName: errorNameOf(error) });
    }
  }

  return {
    async receive({ ownerId, draftId, messageId, contentProvider, quoteToken, sentAt }) {
      const reject = (reason: IntakeRejection, status?: number): IntakeResult => {
        deps.logger.warn('crosspost.media_rejected', { ownerId, reason, ...(status !== undefined ? { status } : {}) });
        return { kind: 'rejected', reason };
      };
      if (contentProvider !== 'line') return reject('external');
      if (sentAt === null) return reject('unordered');

      let content: MessageContentResult;
      try {
        content = await deps.fetchContent(messageId, MAX_INPUT_BYTES);
      } catch (error) {
        deps.logger.warn('crosspost.operation_failed', { ownerId, operation: 'fetch_content', errorName: errorNameOf(error) });
        return reject('temporary');
      }
      switch (content.kind) {
        case 'gone':
          return reject('gone');
        case 'too_large':
          return reject('too_large');
        case 'not_ready':
          return reject('temporary');
        case 'error':
          return reject('temporary', content.status);
        case 'ok':
          break;
      }

      const normalized = await normalizeImage(content.bytes);
      if (!normalized.ok) return reject(normalized.error);

      const key = newKey();
      try {
        await deps.mediaStore.put({ key, bytes: normalized.value.bytes, contentType: 'image/jpeg' });
      } catch (error) {
        deps.logger.warn('crosspost.operation_failed', { ownerId, operation: 'store_media', errorName: errorNameOf(error) });
        return reject('temporary');
      }

      let attached;
      try {
        attached = await attachCrosspostMedia(deps.pool, {
          ownerId,
          draftId,
          media: {
            lineMessageId: messageId,
            lineQuoteToken: quoteToken,
            lineSentAt: new Date(sentAt),
            storageKey: key,
            contentType: 'image/jpeg',
            width: normalized.value.width,
            height: normalized.value.height,
            byteSize: normalized.value.byteSize,
            sha256: normalized.value.sha256,
          },
          expiresAt: new Date(now().getTime() + DRAFT_TTL_MS),
        });
      } catch (error) {
        await deleteQuietly(key, ownerId);
        throw error;
      }

      if (attached.kind !== 'attached') {
        await deleteQuietly(key, ownerId);
        return { kind: attached.kind };
      }
      for (const old of attached.replacedStorageKeys) await deleteQuietly(old, ownerId);
      return { kind: 'attached', draft: attached.draft, replaced: attached.replacedStorageKeys.length > 0 };
    },
  };
}

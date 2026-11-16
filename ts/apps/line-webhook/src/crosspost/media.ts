// 写真の検証と正規化・置き場の境界（line-crosspost design.md「media / intake」・Requirement 2.6, 2.7, 8.2）。
//
// - 受け付ける形式は JPEG・PNG・WebP（先頭のバイトで判定する。Content-Type は参考にしかしない）。
//   HEIC は sharp の配布物が復号しないので、理由を伝えて断る（LINE は送信時に JPEG へ変換するとされるが、
//   「オリジナル画質」で送られた場合の実際の形式は実機で確かめていない・tasks 8.1）。
// - 正規化: 向きの補正 → 長辺 1,440px 以内へ縮小（拡大しない）→ sRGB の JPEG（品質 85）。
//   **メタデータは書き出さない**（sharp は withMetadata を呼ばない限り EXIF・ICC 以外を落とす）。位置情報を含む
//   EXIF をここで取り除く（Req 2.7）。
// - 短辺 250px 未満は断る（Google の写真の最小・前提資料 §4.5）。投稿先ごとのそれ以上の条件
//   （Instagram の比率など）は、各アダプタの availability が判定する。

import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Result } from '@fwlm/db';

/** 受け取る画像のバイト数の上限（これを超えたら読み止める）。 */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
/** 復号する画素数の上限（展開爆弾の防止）。 */
const MAX_INPUT_PIXELS = 50_000_000;
/** 正規化の後の長辺。 */
export const NORMALIZED_LONG_EDGE = 1440;
/** 受け付ける短辺の最小。 */
export const MIN_SHORT_EDGE = 250;
const JPEG_QUALITY = 85;

export type ImageRejection =
  /** JPEG・PNG・WebP でない（HEIC・GIF・動画・壊れた先頭など）。 */
  | 'unsupported_type'
  /** バイト数の上限を超えた。 */
  | 'too_large'
  /** 短辺が小さすぎる。 */
  | 'too_small'
  /** 復号できない。 */
  | 'corrupt';

export interface NormalizedImage {
  bytes: Buffer;
  contentType: 'image/jpeg';
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
}

type DetectedType = 'jpeg' | 'png' | 'webp' | 'heic' | 'other';

/** 先頭のバイトで形式を判定する。 */
export function detectImageType(bytes: Uint8Array): DetectedType {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  const ascii = (from: number, to: number): string => Buffer.from(bytes.subarray(from, to)).toString('latin1');
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|heim|heis)$/.test(ascii(8, 12))) {
    return 'heic';
  }
  return 'other';
}

/** 写真を検証して正規化する。例外は投げない（sharp の例外は corrupt に畳む）。 */
export async function normalizeImage(input: Buffer): Promise<Result<NormalizedImage, ImageRejection>> {
  if (input.length > MAX_INPUT_BYTES) return { ok: false, error: 'too_large' };
  const type = detectImageType(input);
  if (type !== 'jpeg' && type !== 'png' && type !== 'webp') return { ok: false, error: 'unsupported_type' };

  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({
        width: NORMALIZED_LONG_EDGE,
        height: NORMALIZED_LONG_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toColourspace('srgb')
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });

    if (Math.min(info.width, info.height) < MIN_SHORT_EDGE) return { ok: false, error: 'too_small' };
    return {
      ok: true,
      value: {
        bytes: data,
        contentType: 'image/jpeg',
        width: info.width,
        height: info.height,
        byteSize: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      },
    };
  } catch {
    // 復号の失敗（壊れたファイル・画素数の上限超え）。原因の詳細は記録しない（画像の中身に触れない）。
    return { ok: false, error: 'corrupt' };
  }
}

// =====================================================================
// 置き場の境界
// =====================================================================

/**
 * 写真の非公開の置き場。名前（key）は推測できない値を呼び出し側が決める。
 * 投稿先（Meta・Google）は URL から写真を取りに来るので、投稿の実行中にだけ取得用の URL を発行する。
 */
export interface MediaStore {
  put(input: { key: string; bytes: Buffer; contentType: 'image/jpeg' }): Promise<void>;
  /** 無い名前を消しても成功とする（冪等）。 */
  delete(key: string): Promise<void>;
  /**
   * 投稿先が取得するための URL（寿命つき）。発行の方式が決まっていない・使えないときは null。
   * 方式（署名付き URL か、line-webhook の短命の配信経路か）は、Meta・Google が受け付けるかを実測してから
   * 決める（tasks 6.2）。それまでは null を返し、写真付きの投稿先は availability で「準備中」になる。
   */
  issueFetchUrl(key: string, ttlSeconds: number): Promise<string | null>;
  /** issueFetchUrl が URL を返しうるか（availability の判定に使う）。 */
  readonly canIssueFetchUrl: boolean;
}

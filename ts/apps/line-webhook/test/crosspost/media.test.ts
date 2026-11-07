import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { detectImageType, MAX_INPUT_BYTES, normalizeImage } from '../../src/crosspost/media.js';

async function jpegWithExif(width: number, height: number, orientation?: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .jpeg()
    .withMetadata({
      ...(orientation === undefined ? {} : { orientation }),
      exif: {
        IFD0: { Copyright: 'owner', Make: 'TestCam' },
        // 位置情報（GPS の IFD）
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '35/1 41/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '139/1 41/1 0/1' },
      },
    })
    .toBuffer();
}

describe('detectImageType', () => {
  it('先頭のバイトで判定する', async () => {
    expect(detectImageType(await jpegWithExif(10, 10))).toBe('jpeg');
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer();
    expect(detectImageType(png)).toBe('png');
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(16)]);
    expect(detectImageType(heic)).toBe('heic');
    expect(detectImageType(Buffer.from('GIF89a'))).toBe('other');
  });
});

describe('normalizeImage', () => {
  it('EXIF（位置情報を含む）を落とし、向きを補正して JPEG にする', async () => {
    const input = await jpegWithExif(600, 400, 6); // 6 = 90 度回転
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();

    const result = await normalizeImage(input);
    if (!result.ok) throw new Error(result.error);
    const after = await sharp(result.value.bytes).metadata();
    expect(after.format).toBe('jpeg');
    expect(after.exif).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    // 向きの補正で縦横が入れ替わる
    expect({ w: result.value.width, h: result.value.height }).toEqual({ w: 400, h: 600 });
    expect(result.value.byteSize).toBe(result.value.bytes.length);
    expect(result.value.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.value.bytes.includes(Buffer.from('TestCam'))).toBe(false);
  });

  it('長辺 1,440px 以内へ縮小し、拡大はしない', async () => {
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#888' } }).jpeg().toBuffer();
    const result = await normalizeImage(big);
    if (!result.ok) throw new Error(result.error);
    expect({ w: result.value.width, h: result.value.height }).toEqual({ w: 1440, h: 960 });

    const small = await sharp({ create: { width: 500, height: 300, channels: 3, background: '#888' } }).png().toBuffer();
    const kept = await normalizeImage(small);
    if (!kept.ok) throw new Error(kept.error);
    expect({ w: kept.value.width, h: kept.value.height }).toEqual({ w: 500, h: 300 });
  });

  it('小さすぎる・壊れた・未対応の形式・大きすぎる入力を断る', async () => {
    const tiny = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#000' } }).jpeg().toBuffer();
    expect(await normalizeImage(tiny)).toEqual({ ok: false, error: 'too_small' });
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
    expect(await normalizeImage(broken)).toEqual({ ok: false, error: 'corrupt' });
    expect(await normalizeImage(Buffer.from('GIF89a........'))).toEqual({ ok: false, error: 'unsupported_type' });
    expect(await normalizeImage(Buffer.alloc(MAX_INPUT_BYTES + 1))).toEqual({ ok: false, error: 'too_large' });
  });
});

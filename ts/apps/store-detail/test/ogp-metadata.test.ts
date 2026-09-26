import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { metadata } from '../app/layout';

// リンクを共有したときのプレビュー（OGP）を固定する。
// og:image は JPEG を先に置く。WebP は LINE のプレビューが表示するかを一次情報で確かめられていないため、
// 対応が確実な JPEG をクローラが先に拾うようにする。幅と高さは、同梱した画像のヘッダから直接読んだ実寸と
// 突き合わせる（宣言だけを書き換えても、画像を差し替えても食い違いが赤になる）。

const publicDir = path.join(import.meta.dirname, '..', 'public');

/** JPEG の SOF セグメントから寸法を読む。 */
function jpegSize(buf: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < buf.length) {
    const marker = buf.readUInt16BE(offset);
    const length = buf.readUInt16BE(offset + 2);
    // SOF0〜SOF15（DHT・JPG・DAC を除く）が寸法を持つ。
    if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG の SOF が見つからない');
}

/** WebP（VP8 / VP8L / VP8X）の寸法を読む。 */
function webpSize(buf: Buffer): { width: number; height: number } {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WEBP');
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  throw new Error(`未知の WebP チャンク: ${chunk}`);
}

type OgImage = { url: string | URL; width?: number; height?: number; type?: string; alt?: string };

const images = (metadata.openGraph?.images ?? []) as OgImage[];

describe('OGP の metadata は同梱した画像と一致する', () => {
  it('公開 URL を基準に持ち、og:image は JPEG・WebP の順に並ぶ', () => {
    expect(new URL(String(metadata.metadataBase)).protocol).toBe('https:');
    expect(images.map((image) => image.type)).toEqual(['image/jpeg', 'image/webp']);
    expect(images.map((image) => String(image.url))).toEqual(['/ogp.jpg', '/ogp.webp']);
  });

  it.each([
    ['/ogp.jpg', jpegSize],
    ['/ogp.webp', webpSize],
  ] as const)('%s の宣言した寸法が画像の実寸と一致し、1200×630 である', (url, readSize) => {
    const image = images.find((candidate) => String(candidate.url) === url);
    expect(image, url).toBeDefined();
    const actual = readSize(readFileSync(path.join(publicDir, url.slice(1))));
    expect({ width: image!.width, height: image!.height }).toEqual(actual);
    expect(actual).toEqual({ width: 1200, height: 630 });
  });

  it('画像には代替テキストがあり、画面の役割（店舗詳細）を含む', () => {
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.alt ?? '').toContain('店舗詳細');
    }
  });

  it('大きな画像のカードとして共有され、X でも JPEG を使う', () => {
    const twitter = metadata.twitter as { card?: string; images?: unknown } | undefined;
    expect(twitter?.card).toBe('summary_large_image');
    expect(twitter?.images).toEqual(['/ogp.jpg']);
  });
});

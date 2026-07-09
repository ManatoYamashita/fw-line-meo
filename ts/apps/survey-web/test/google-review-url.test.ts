import { describe, it, expect } from 'vitest';
import { buildGoogleReviewUrl } from '../src/lib/google-review-url';

describe('buildGoogleReviewUrl', () => {
  it('Place ID から writereview URL を組み立てる', () => {
    expect(buildGoogleReviewUrl('ChIJ_test_place')).toBe(
      'https://search.google.com/local/writereview?placeid=ChIJ_test_place',
    );
  });

  it('特殊文字を含む Place ID を URL エンコードする', () => {
    const url = buildGoogleReviewUrl('a b&c/d+e');
    expect(url).toBe('https://search.google.com/local/writereview?placeid=a%20b%26c%2Fd%2Be');
    // クエリを壊す生の & / が含まれないこと
    expect(url).not.toContain('&c');
    expect(url).not.toContain('/d');
  });

  it('空の Place ID は拒否する', () => {
    expect(() => buildGoogleReviewUrl('')).toThrow();
  });
});

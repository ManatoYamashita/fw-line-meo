// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { markAnswered, isRecentlyAnswered } from '../src/app/s/[storeId]/answered-flag';

const STORE = 'store-1';

describe('answered-flag', () => {
  beforeEach(() => localStorage.clear());

  it('未回答なら false', () => {
    expect(isRecentlyAnswered(STORE)).toBe(false);
  });

  it('記録後は true', () => {
    markAnswered(STORE, 1000);
    expect(isRecentlyAnswered(STORE, 1000)).toBe(true);
  });

  it('24 時間経過後は false', () => {
    markAnswered(STORE, 1000);
    expect(isRecentlyAnswered(STORE, 1000 + 24 * 60 * 60 * 1000 + 1)).toBe(false);
  });

  it('店舗ごとに独立', () => {
    markAnswered('store-a', 1000);
    expect(isRecentlyAnswered('store-b', 1000)).toBe(false);
  });
});

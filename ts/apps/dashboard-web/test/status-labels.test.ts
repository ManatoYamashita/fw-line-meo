import { describe, expect, it } from 'vitest';
import { COMPETITOR_STATUS_LABEL, competitorStatusLabel } from '../src/lib/status-labels';

// 競合設定の表示語（agency-dashboard Requirement 4.3・Issue #526 で店舗一覧から移した・tasks 9.3）。
describe('competitorStatusLabel', () => {
  it('競合が設定済みかどうかから、店舗一覧と同じ語を引く', () => {
    expect(competitorStatusLabel(true)).toBe('競合設定済み');
    expect(competitorStatusLabel(false)).toBe('競合未設定');
    expect(COMPETITOR_STATUS_LABEL).toEqual({ configured: '競合設定済み', unconfigured: '競合未設定' });
  });
});

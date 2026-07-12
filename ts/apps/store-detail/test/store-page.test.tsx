// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import StorePage from '../app/store/page';

// Task 2.3: 詳細閲覧アプリの骨格（プレースホルダ画面）を検証する。
// LIFF 認可・実データ取得（Task 5.1–5.3）はまだ存在しないため、
// ここでは「日本語のプレースホルダ文言が表示されること」のみを観察可能な完了条件として検証する。
describe('store detail placeholder page', () => {
  it('準備中であることを示す日本語のプレースホルダを表示する', () => {
    render(<StorePage />);

    expect(screen.getByText('店舗詳細（準備中）')).toBeDefined();
  });

  it('書込操作（フォーム・ボタン等）を一切含まない', () => {
    const { container } = render(<StorePage />);

    expect(container.querySelectorAll('form, button, input, textarea, select')).toHaveLength(0);
  });
});

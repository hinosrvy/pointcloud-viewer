import { describe, expect, it } from 'vitest';
import { formatVersionLabel } from './ui';

// Issue #9: バージョン・Gitショートハッシュ・ビルド日付を1行の表示用文字列に整形する。
describe('formatVersionLabel', () => {
  it('バージョン・ビルドハッシュ・ビルド日付を整形する', () => {
    expect(formatVersionLabel('0.1.0', 'a1b2c3d', '2026-09-30')).toBe('v0.1.0 (a1b2c3d, 2026-09-30)');
  });

  it('ビルドハッシュが取得できない場合はunknownをそのまま表示する', () => {
    expect(formatVersionLabel('0.1.0', 'unknown', '2026-09-30')).toBe('v0.1.0 (unknown, 2026-09-30)');
  });
});

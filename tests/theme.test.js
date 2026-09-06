import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { themeSelect } = vi.hoisted(() => ({ themeSelect: { value: 'system' } }));
vi.mock('../src/dom.mjs', () => ({ themeSelect }));

let theme;
let media;
let storage;

beforeEach(async () => {
  vi.resetModules();
  media = { matches: true };
  storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
  themeSelect.value = 'system';
  vi.stubGlobal('window', { matchMedia: () => media });
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
  vi.stubGlobal('localStorage', storage);
  theme = await import('../src/theme.mjs');
});

afterEach(() => vi.unstubAllGlobals());

describe('theme preferences', () => {
  it.each(['light', 'dark', 'system'])('restores the saved %s preference', (preference) => {
    storage.getItem.mockReturnValue(preference);
    theme.initTheme();
    expect(themeSelect.value).toBe(preference);
    expect(document.documentElement.dataset.theme).toBe(preference === 'system' ? 'dark' : preference);
  });

  it.each([null, '', 'invalid', '__proto__'])('falls back to system for invalid saved preference %s', (preference) => {
    storage.getItem.mockReturnValue(preference);
    theme.initTheme();
    expect(themeSelect.value).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('initializes even when browser storage access is denied', () => {
    storage.getItem.mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    expect(() => theme.initTheme()).not.toThrow();
    expect(themeSelect.value).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('applies a theme even when persistence fails', () => {
    storage.setItem.mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    expect(() => theme.handleThemeChange('light')).not.toThrow();
    expect(themeSelect.value).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows system changes only when system is selected', () => {
    theme.initTheme();
    media.matches = false;
    theme.handleSystemThemeChange();
    expect(document.documentElement.dataset.theme).toBe('light');
    theme.handleThemeChange('dark');
    theme.handleSystemThemeChange();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

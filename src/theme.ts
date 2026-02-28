import { THEME_STORAGE_KEY } from './constants';
import { themeSelect } from './dom';
import type { ThemePreference } from './types';

export const prefersDarkScheme: MediaQueryList = window.matchMedia('(prefers-color-scheme: dark)');

export function getSystemTheme(): 'dark' | 'light' {
  return prefersDarkScheme.matches ? 'dark' : 'light';
}

export function applyThemePreference(preference: string): void {
  const resolved = preference === 'system' ? getSystemTheme() : preference;
  document.documentElement.dataset.theme = resolved;
}

export function initTheme(): void {
  const savedPreference = localStorage.getItem(THEME_STORAGE_KEY) || 'system';
  themeSelect.value = savedPreference;
  applyThemePreference(savedPreference);
}

export function handleThemeChange(preference: ThemePreference): void {
  localStorage.setItem(THEME_STORAGE_KEY, preference);
  applyThemePreference(preference);
}

export function handleSystemThemeChange(): void {
  if (themeSelect.value === 'system') {
    applyThemePreference('system');
  }
}

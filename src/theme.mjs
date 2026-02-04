import { THEME_STORAGE_KEY } from './constants.mjs';
import { themeSelect } from './dom.mjs';

export const prefersDarkScheme = window.matchMedia('(prefers-color-scheme: dark)');

export function getSystemTheme() {
  return prefersDarkScheme.matches ? 'dark' : 'light';
}

export function applyThemePreference(preference) {
  const resolved = preference === 'system' ? getSystemTheme() : preference;
  document.documentElement.dataset.theme = resolved;
}

export function initTheme() {
  const savedPreference = localStorage.getItem(THEME_STORAGE_KEY) || 'system';
  themeSelect.value = savedPreference;
  applyThemePreference(savedPreference);
}

export function handleThemeChange(preference) {
  localStorage.setItem(THEME_STORAGE_KEY, preference);
  applyThemePreference(preference);
}

export function handleSystemThemeChange() {
  if (themeSelect.value === 'system') {
    applyThemePreference('system');
  }
}

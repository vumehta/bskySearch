import { THEME_STORAGE_KEY } from './constants.mjs';
import { themeSelect } from './dom.mjs';

export const prefersDarkScheme = window.matchMedia('(prefers-color-scheme: dark)');

export function getSystemTheme() {
  return prefersDarkScheme.matches ? 'dark' : 'light';
}

function normalizeThemePreference(preference) {
  return ['light', 'dark', 'system'].includes(preference) ? preference : 'system';
}

export function applyThemePreference(preference) {
  preference = normalizeThemePreference(preference);
  const resolved = preference === 'system' ? getSystemTheme() : preference;
  document.documentElement.dataset.theme = resolved;
}

export function initTheme() {
  let savedPreference = 'system';
  try {
    savedPreference = normalizeThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // Browsers can deny storage while still allowing the app to run.
  }
  themeSelect.value = savedPreference;
  applyThemePreference(savedPreference);
}

export function handleThemeChange(preference) {
  preference = normalizeThemePreference(preference);
  themeSelect.value = preference;
  applyThemePreference(preference);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Keep the selected theme usable even when it cannot be persisted.
  }
}

export function handleSystemThemeChange() {
  if (themeSelect.value === 'system') {
    applyThemePreference('system');
  }
}

import { useEffect, useState } from 'react';
import { THEME_STORAGE_KEY } from './constants';
import type { ThemePreference } from './types';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved;
    }
    return 'system';
  });

  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() =>
    preference === 'system' ? getSystemTheme() : preference,
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const applyTheme = () => {
      const resolved = preference === 'system' ? getSystemTheme() : preference;
      setResolvedTheme(resolved);
      document.documentElement.dataset.theme = resolved;
    };

    const onSchemeChange = () => {
      if (preference === 'system') {
        applyTheme();
      }
    };

    applyTheme();

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onSchemeChange);
    } else {
      media.addListener(onSchemeChange);
    }

    return () => {
      if (typeof media.removeEventListener === 'function') {
        media.removeEventListener('change', onSchemeChange);
      } else {
        media.removeListener(onSchemeChange);
      }
    };
  }, [preference]);

  const setThemePreference = (value: ThemePreference) => {
    localStorage.setItem(THEME_STORAGE_KEY, value);
    setPreference(value);
  };

  return {
    preference,
    resolvedTheme,
    setThemePreference,
  };
}

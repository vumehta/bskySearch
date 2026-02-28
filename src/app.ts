import { state } from './state';
import { normalizeSortValue } from './utils';
import {
  autoRefreshToggle,
  expandTermsToggle,
  minLikesInput,
  postUrlInput,
  quoteForm,
  quoteTabs,
  refreshIntervalSelect,
  searchBtn,
  sortSelect,
  termsInput,
  themeSelect,
  timeFilterSelect,
} from './dom';
import {
  applySearchSortChange,
  cancelDebouncedSearch,
  debouncedSearch,
  disableAutoRefresh,
  enableAutoRefresh,
  focusSearchInput,
  performSearch,
  scheduleNextRefresh,
  updateExpansionSummary,
  updateRefreshInterval,
  updateRefreshMeta,
  updateSearchURL,
} from './search';
import {
  handleQuoteTabClick,
  performQuoteSearch,
  updateQuoteTabs,
} from './quotes';
import {
  handleSystemThemeChange,
  handleThemeChange,
  initTheme,
  prefersDarkScheme,
} from './theme';
import type { ThemePreference } from './types';

function initFromURL(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get('terms')) {
    termsInput.value = params.get('terms')!;
  }
  if (params.get('minLikes')) {
    minLikesInput.value = params.get('minLikes')!;
  }
  if (params.get('time')) {
    const timeValue = params.get('time')!;
    if (['1', '6', '12', '24', '48', '168'].includes(timeValue)) {
      timeFilterSelect.value = timeValue;
    }
  }
  if (params.get('sort')) {
    const sortValue = params.get('sort')!;
    if (['top', 'latest'].includes(sortValue)) {
      sortSelect.value = sortValue;
    }
  }
  state.searchSort = normalizeSortValue(sortSelect.value);
  if (params.get('expand') === '1') {
    expandTermsToggle.checked = true;
  }

  const postParam = params.get('post');
  const sortParam = params.get('sort');
  if (sortParam && ['likes', 'recent', 'oldest'].includes(sortParam)) {
    state.quoteSort = sortParam as 'likes' | 'recent' | 'oldest';
    updateQuoteTabs();
  }
  if (postParam) {
    postUrlInput.value = postParam;
    performQuoteSearch();
  }

  updateExpansionSummary();
}

// Event listeners
searchBtn.addEventListener('click', () => {
  cancelDebouncedSearch();
  performSearch();
});

quoteForm.addEventListener('submit', (event: Event) => {
  event.preventDefault();
  performQuoteSearch();
});

themeSelect.addEventListener('change', (event: Event) => {
  handleThemeChange((event.target as HTMLSelectElement).value as ThemePreference);
});

prefersDarkScheme.addEventListener('change', () => {
  handleSystemThemeChange();
});

autoRefreshToggle.addEventListener('change', (event: Event) => {
  if ((event.target as HTMLInputElement).checked) {
    enableAutoRefresh();
  } else {
    disableAutoRefresh();
  }
});

refreshIntervalSelect.addEventListener('change', () => {
  updateRefreshInterval();
  if (state.autoRefreshEnabled) {
    scheduleNextRefresh();
  } else {
    updateRefreshMeta();
  }
});

sortSelect.addEventListener('change', () => {
  state.searchSort = normalizeSortValue(sortSelect.value);
  updateSearchURL();
  applySearchSortChange();
  if (state.autoRefreshEnabled) {
    scheduleNextRefresh();
  }
});

quoteTabs.addEventListener('click', (event: Event) => {
  handleQuoteTabClick(event);
});

termsInput.addEventListener('keypress', (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    cancelDebouncedSearch();
    performSearch();
  }
});

termsInput.addEventListener('input', () => {
  updateExpansionSummary();
  if (!termsInput.value.trim()) {
    cancelDebouncedSearch();
    state.pendingSearch = false;
    return;
  }
  debouncedSearch();
});

minLikesInput.addEventListener('keypress', (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    cancelDebouncedSearch();
    performSearch();
  }
});

minLikesInput.addEventListener('input', debouncedSearch);

expandTermsToggle.addEventListener('change', () => {
  updateSearchURL();
  updateExpansionSummary();
});

// Initialize
initTheme();
initFromURL();
updateRefreshInterval();
updateRefreshMeta();
updateExpansionSummary();
focusSearchInput();

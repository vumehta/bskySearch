import { state } from './state.mjs';
import { normalizeSortValue } from './utils.mjs';
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
} from './dom.mjs';
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
} from './search.mjs';
import {
  handleQuoteTabClick,
  performQuoteSearch,
  updateQuoteTabs,
} from './quotes.mjs';
import {
  handleSystemThemeChange,
  handleThemeChange,
  initTheme,
  prefersDarkScheme,
} from './theme.mjs';
import { updateURLWithParams } from './url.mjs';

const SEARCH_SORT_VALUES = ['top', 'latest'];
const QUOTE_SORT_VALUES = ['likes', 'recent', 'oldest'];

function initFromURL() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('terms')) {
    termsInput.value = params.get('terms');
  }
  if (params.get('minLikes')) {
    minLikesInput.value = params.get('minLikes');
  }
  if (params.get('time')) {
    const timeValue = params.get('time');
    if (['1', '6', '12', '24', '48', '168'].includes(timeValue)) {
      timeFilterSelect.value = timeValue;
    }
  }
  const searchSortParam = params.get('searchSort');
  const legacySortParam = params.get('sort');
  const hasValidSearchSort = SEARCH_SORT_VALUES.includes(searchSortParam);
  const hasValidLegacySearchSort = SEARCH_SORT_VALUES.includes(legacySortParam);
  const resolvedSearchSort = hasValidSearchSort
    ? searchSortParam
    : hasValidLegacySearchSort
      ? legacySortParam
      : null;
  if (resolvedSearchSort) {
    sortSelect.value = resolvedSearchSort;
  }
  state.searchSort = normalizeSortValue(sortSelect.value);
  if (params.get('expand') === '1') {
    expandTermsToggle.checked = true;
  }

  const postParam = params.get('post');
  const quoteSortParam = params.get('quoteSort');
  const hasValidQuoteSort = QUOTE_SORT_VALUES.includes(quoteSortParam);
  const hasValidLegacyQuoteSort = QUOTE_SORT_VALUES.includes(legacySortParam);
  const resolvedQuoteSort = hasValidQuoteSort
    ? quoteSortParam
    : hasValidLegacyQuoteSort
      ? legacySortParam
      : null;
  if (resolvedQuoteSort) {
    state.quoteSort = resolvedQuoteSort;
    updateQuoteTabs();
  }
  if (postParam) {
    postUrlInput.value = postParam;
    performQuoteSearch();
  }

  if (!hasValidSearchSort && hasValidLegacySearchSort) {
    params.set('searchSort', legacySortParam);
  }
  if (!hasValidQuoteSort && hasValidLegacyQuoteSort) {
    params.set('quoteSort', legacySortParam);
  }
  if ((!hasValidSearchSort && hasValidLegacySearchSort) || (!hasValidQuoteSort && hasValidLegacyQuoteSort)) {
    params.delete('sort');
    updateURLWithParams(params);
  }

  updateExpansionSummary();
}

// Event listeners
searchBtn.addEventListener('click', () => {
  cancelDebouncedSearch();
  performSearch();
});

quoteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  performQuoteSearch();
});

themeSelect.addEventListener('change', (event) => {
  handleThemeChange(event.target.value);
});

prefersDarkScheme.addEventListener('change', () => {
  handleSystemThemeChange();
});

autoRefreshToggle.addEventListener('change', (event) => {
  if (event.target.checked) {
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

quoteTabs.addEventListener('click', (event) => {
  handleQuoteTabClick(event);
});

termsInput.addEventListener('keypress', (event) => {
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

minLikesInput.addEventListener('keypress', (event) => {
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

import { state } from './state.mjs';
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
  cancelDebouncedSearch,
  debouncedSearch,
  disableAutoRefresh,
  enableAutoRefresh,
  focusSearchInput,
  performSearch,
  recomputeDerivedPosts,
  scheduleNextRefresh,
  scheduleRender,
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
  if (params.get('sort')) {
    const sortValue = params.get('sort');
    if (['top', 'latest'].includes(sortValue)) {
      sortSelect.value = sortValue;
    }
  }
  state.searchSort = sortSelect.value === 'latest' ? 'latest' : 'top';
  if (params.get('expand') === '1') {
    expandTermsToggle.checked = true;
  }

  const postParam = params.get('post');
  const sortParam = params.get('sort');
  if (sortParam && ['likes', 'recent', 'oldest'].includes(sortParam)) {
    state.quoteSort = sortParam;
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
  state.searchSort = sortSelect.value === 'latest' ? 'latest' : 'top';
  updateSearchURL();
  if (state.allPosts.length > 0) {
    recomputeDerivedPosts();
    scheduleRender();
  }
  if (state.autoRefreshEnabled) {
    scheduleNextRefresh();
  }
});

timeFilterSelect.addEventListener('change', () => {
  state.timeFilterHours = parseInt(timeFilterSelect.value) || 24;
  updateSearchURL();
  if (state.searchTerms.length > 0) {
    recomputeDerivedPosts();
    scheduleRender();
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

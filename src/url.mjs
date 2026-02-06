export function updateURLWithParams(params) {
  const newURL =
    window.location.pathname + (params.toString() ? `?${params.toString()}` : '');
  window.history.replaceState({}, '', newURL);
}

export function setQueryParam(params, key, value) {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}

const SEARCH_SORT_VALUES = ['top', 'latest'];
const QUOTE_SORT_VALUES = ['likes', 'recent', 'oldest'];

export function isSearchSort(value) {
  return SEARCH_SORT_VALUES.includes(value);
}

export function isQuoteSort(value) {
  return QUOTE_SORT_VALUES.includes(value);
}

export function resolveSearchSortParam(params) {
  const explicitSort = params.get('searchSort');
  if (isSearchSort(explicitSort)) {
    return explicitSort;
  }

  const legacySort = params.get('sort');
  if (isSearchSort(legacySort)) {
    return legacySort;
  }

  return null;
}

export function resolveQuoteSortParam(params) {
  const explicitSort = params.get('quoteSort');
  if (isQuoteSort(explicitSort)) {
    return explicitSort;
  }

  const legacySort = params.get('sort');
  if (isQuoteSort(legacySort)) {
    return legacySort;
  }

  return null;
}

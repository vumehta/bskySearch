export function updateURLWithParams(params) {
  const query = params.toString();
  const newURL = window.location.pathname + (query ? `?${query}` : '');
  window.history.replaceState({}, '', newURL);
}

export function setQueryParam(params, key, value) {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}

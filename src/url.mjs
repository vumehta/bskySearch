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

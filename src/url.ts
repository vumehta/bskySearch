export function updateURLWithParams(params: URLSearchParams): void {
  const newURL =
    window.location.pathname + (params.toString() ? `?${params.toString()}` : '');
  window.history.replaceState({}, '', newURL);
}

export function setQueryParam(params: URLSearchParams, key: string, value: string): void {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}

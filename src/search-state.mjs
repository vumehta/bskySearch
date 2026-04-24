export function consumePendingSearch(state) {
  if (!state.pendingSearch) {
    return false;
  }

  state.pendingSearch = false;
  return true;
}

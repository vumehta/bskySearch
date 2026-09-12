import { handleThemeChange, handleSystemThemeChange, initTheme, prefersDarkScheme } from './theme.mjs';

const $ = id => document.getElementById(id);
const model = { generation: 0, cursor: null, throughId: 0, searches: [], items: [], signedIn: false, checking: false, loading: false, poll: null };

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function message(text = '', error = false) {
  $('monitorStatus').textContent = text;
  $('monitorStatus').hidden = !text;
  $('monitorStatus').classList.toggle('is-error', error);
}

async function api(resource, options = {}, params = {}) {
  const response = await fetch(`/api/monitor?${new URLSearchParams({ resource, ...params })}`, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && resource !== 'session') showLogin();
    throw new Error(data.error || 'Could not load your inbox. Please try again.');
  }
  return data;
}

function showLogin() {
  model.signedIn = false;
  model.generation++;
  clearTimeout(model.poll);
  $('monitorDashboard').hidden = true;
  $('monitorLoading').hidden = true;
  $('signOut').hidden = true;
  $('loginPanel').hidden = false;
  $('navUnread').hidden = true;
  $('inboxPosts').replaceChildren();
  $('savedSearches').replaceChildren();
}

function relativeTime(value) {
  if (!value) return 'Waiting for first check';
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000));
  if (minutes < 1) return 'Checked just now';
  if (minutes < 60) return `Checked ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Checked ${hours}h ago` : `Checked ${Math.floor(hours / 24)}d ago`;
}

function action(text, callback, className = 'button-quiet') {
  const button = node('button', text, className);
  button.type = 'button';
  button.addEventListener('click', () => busy(button, callback));
  return button;
}

async function busy(button, callback) {
  button.disabled = true;
  try { await callback(); }
  catch (error) { message(error.message, true); }
  finally {
    if (button.isConnected) button.disabled = false;
    syncControls();
  }
}

function syncControls() {
  $('checkNow').disabled = model.checking || !model.searches.some(s => s.enabled);
  $('markAllRead').disabled = model.loading || !model.items.some(item => !item.readAt);
  $('inboxMore').disabled = model.loading;
}

function renderSearches(data) {
  model.searches = data.searches;
  model.checking = data.checking;
  $('unreadTotal').textContent = data.unread.toLocaleString();
  $('navUnread').textContent = data.unread.toLocaleString();
  $('navUnread').hidden = !data.unread;
  $('searchCount').textContent = `${data.searches.length} / 10`;
  const active = data.searches.filter(s => s.enabled).length;
  $('inboxSummary').textContent = `${data.total.toLocaleString()} ${data.total === 1 ? 'match' : 'matches'} collected · ${active} active ${active === 1 ? 'search' : 'searches'}`;
  const errors = data.searches.filter(s => s.enabled && s.last_error).length;
  $('collectorStatus').textContent = data.checking ? 'Checking your searches…' : errors ? `${errors} ${errors === 1 ? 'search needs' : 'searches need'} attention` : 'Checks every 10 minutes';
  $('collectorStatus').classList.toggle('is-error', errors > 0);
  syncControls();
  const list = $('savedSearches');
  list.replaceChildren();
  if (!data.searches.length) list.append(node('p', 'Save a topic, phrase, or account to start collecting matches.', 'fine-print search-empty'));
  for (const search of data.searches) {
    const item = node('article', undefined, `saved-search${search.enabled ? '' : ' is-paused'}`);
    const title = node('div', undefined, 'saved-search-title');
    const select = action(search.name, async () => { $('inboxSearch').value = search.id; await refresh(); }, 'saved-search-link');
    title.append(select, node('span', String(search.unread_count), 'count-badge'));
    item.append(title, node('p', search.query, 'saved-query'));
    const status = !search.enabled ? 'Paused' : search.last_error || (search.scan_until ? 'Catching up · more pages on the next check' : relativeTime(search.last_checked_at));
    item.append(node('p', status, `fine-print${search.last_error && search.enabled ? ' is-error' : ''}`));
    const controls = node('div', undefined, 'saved-search-actions');
    controls.append(action(search.enabled ? 'Pause' : 'Resume', async () => {
      await api('searches', { method: 'PATCH', body: { enabled: !search.enabled } }, { id: search.id });
      message(search.enabled ? 'Search paused.' : 'Search resumed. Collection will continue from where it stopped.');
      await refresh();
      if (!search.enabled) pollAfterCheck();
    }));
    controls.append(action('Remove', async () => {
      if (!window.confirm(`Remove “${search.name}”? Matches found only by this search will also be removed.`)) return;
      await api('searches', { method: 'DELETE' }, { id: search.id });
      if ($('inboxSearch').value === search.id) $('inboxSearch').value = '';
      message('Search removed.');
      await refresh();
    }));
    item.append(controls);
    list.append(item);
  }
  const selected = $('inboxSearch').value;
  $('inboxSearch').replaceChildren(new Option('All searches', ''), ...data.searches.map(s => new Option(s.name, s.id)));
  $('inboxSearch').value = data.searches.some(s => s.id === selected) ? selected : '';
}

function renderInbox() {
  const list = $('inboxPosts');
  list.replaceChildren();
  if (!model.items.length) {
    const empty = node('div', undefined, 'monitor-empty');
    const hasSearches = model.searches.length > 0;
    empty.append(node('h3', hasSearches ? ($('inboxView').value === 'unread' ? 'You’re all caught up' : 'No matches yet') : 'A little less searching. A little more finding.'));
    empty.append(node('p', hasSearches ? 'New matches will appear here after a successful check. You can refresh your inbox anytime.' : 'Add your first saved search. We’ll collect matching posts for you, starting with the past hour.'));
    list.append(empty);
  }
  for (const item of model.items) {
    const post = item.post;
    const card = node('article', undefined, `inbox-post${item.readAt ? ' is-read' : ''}`);
    const header = node('div', undefined, 'inbox-post-header');
    const author = node('div');
    author.append(node('strong', post.author.displayName || post.author.handle), node('span', `@${post.author.handle}`, 'inbox-handle'));
    const date = node('time', new Date(post.createdAt || item.foundAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), 'fine-print');
    header.append(author, date);
    card.append(header, node('p', post.text, 'inbox-post-text'));
    const tags = node('div', undefined, 'inbox-tags');
    for (const name of item.searches) tags.append(node('span', name, 'inbox-tag'));
    card.append(tags);
    const footer = node('div', undefined, 'inbox-post-footer');
    footer.append(node('span', `${post.likeCount.toLocaleString()} likes · ${post.replyCount.toLocaleString()} replies`, 'fine-print'));
    const buttons = node('div');
    const open = node('a', 'Open on Bluesky ↗');
    open.href = post.url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    buttons.append(open);
    if (!item.readAt) buttons.append(action('Mark read', async () => {
      await api('read', { method: 'POST', body: { ids: [item.id] } });
      await refresh();
    }));
    else buttons.append(node('span', 'Read', 'fine-print'));
    footer.append(buttons);
    card.append(footer);
    list.append(card);
  }
  $('inboxMore').hidden = !model.cursor;
  $('markAllRead').disabled = !model.items.some(item => !item.readAt);
}

async function refresh(append = false) {
  const generation = ++model.generation;
  const params = { search: $('inboxSearch').value, unread: $('inboxView').value === 'unread' ? '1' : '0' };
  if (append && model.cursor) params.before = String(model.cursor);
  model.loading = true;
  syncControls();
  $('inboxPosts').setAttribute('aria-busy', 'true');
  try {
    const [summary, inbox] = await Promise.all([api('searches'), api('inbox', {}, params)]);
    if (generation !== model.generation) return;
    renderSearches(summary);
    model.items = append ? [...model.items, ...inbox.items] : inbox.items;
    model.cursor = inbox.nextCursor;
    if (!append) model.throughId = inbox.throughId;
    renderInbox();
    $('monitorLoading').hidden = true;
    $('loginPanel').hidden = true;
    $('monitorDashboard').hidden = false;
    $('signOut').hidden = false;
    model.signedIn = true;
  } finally {
    if (generation === model.generation) {
      model.loading = false;
      $('inboxPosts').removeAttribute('aria-busy');
      syncControls();
    }
  }
}

function pollAfterCheck(attempt = 0) {
  clearTimeout(model.poll);
  if (!model.signedIn || attempt >= 8) return;
  model.poll = setTimeout(async () => {
    try { await refresh(); }
    catch (error) { message(error.message, true); return; }
    if (model.signedIn && model.checking) pollAfterCheck(attempt + 1);
    else message();
  }, 4000);
}

$('loginForm').addEventListener('submit', event => {
  event.preventDefault();
  busy(event.submitter, async () => {
    await api('session', { method: 'POST', body: { password: $('monitorPassword').value } });
    $('monitorPassword').value = '';
    message();
    await refresh();
  });
});
$('saveSearchForm').addEventListener('submit', event => {
  event.preventDefault();
  busy(event.submitter, async () => {
    await api('searches', { method: 'POST', body: { query: $('monitorQuery').value, name: $('monitorName').value } });
    $('saveSearchForm').reset();
    message('Search saved. The first matches will appear after a successful check.');
    await refresh();
    pollAfterCheck();
  });
});
$('signOut').addEventListener('click', () => busy($('signOut'), async () => { await api('session', { method: 'DELETE' }); showLogin(); message('Signed out. Your searches will keep running.'); }));
$('checkNow').addEventListener('click', () => busy($('checkNow'), async () => {
  await api('check', { method: 'POST' });
  message('Checking for new matches…');
  await refresh();
  pollAfterCheck();
}));
$('refreshInbox').addEventListener('click', () => busy($('refreshInbox'), async () => { await refresh(); message('Inbox refreshed.'); }));
$('inboxMore').addEventListener('click', () => busy($('inboxMore'), () => refresh(true)));
$('markAllRead').addEventListener('click', () => busy($('markAllRead'), async () => {
  await api('read', { method: 'POST', body: { throughId: model.throughId, search: $('inboxSearch').value } });
  await refresh();
  message('Marked as read. Any matches arriving after you loaded this inbox stay unread.');
}));
for (const id of ['inboxSearch', 'inboxView']) $(id).addEventListener('change', () => { clearTimeout(model.poll); refresh().catch(error => message(error.message, true)); });
$('themeSelect').addEventListener('change', event => handleThemeChange(event.target.value));
prefersDarkScheme.addEventListener('change', handleSystemThemeChange);
initTheme();

async function init() {
  try {
    const session = await api('session');
    if (session.signedIn) await refresh();
    else showLogin();
  } catch (error) {
    $('monitorLoading').hidden = true;
    message(error.message, true);
    const retry = action('Try again', async () => { retry.remove(); message(); await init(); });
    $('monitorStatus').append(document.createTextNode(' '), retry);
  }
}
init();

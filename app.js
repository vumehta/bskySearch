'use strict';

const PUBLIC_API = 'https://public.api.bsky.app/xrpc';
const SEARCH_API = '/api/search';
const INITIAL_RENDER_LIMIT = 200;
const RENDER_STEP = 100;
const SEARCH_DEBOUNCE_MS = 300;
const INITIAL_MAX_PAGES = 2;
const SEARCH_CACHE_TTL_MS = 30000;

// DID cache to avoid duplicate lookups
const didCache = new Map();
// Search results cache: key -> { data, timestamp }
const searchCache = new Map();
let searchDebounceTimer = null;

// State
let allPosts = [];
let currentCursors = {};
let rawSearchTerms = [];
let searchTerms = [];
let searchSort = 'top';
let minLikes = 10;
let timeFilterHours = 24;
let isLoading = false;
let isRefreshing = false;
let pendingSearch = false;
let renderLimit = INITIAL_RENDER_LIMIT;
let autoRefreshEnabled = false;
let refreshIntervalMs = 5 * 60 * 1000;
let refreshTimerId = null;
let refreshCountdownId = null;
let nextRefreshAt = null;
let lastRefreshAt = null;
let lastRefreshNewCount = null;
let lastRefreshError = null;
let pendingPosts = [];
let newPostUris = new Set();
let clearHighlightsTimeout = null;
let allQuotes = [];
let quoteSort = 'likes';
let isQuoteLoading = false;
let quoteCursor = null;
let quoteSeenCursors = new Set();
let quoteTotalCount = null;
let activeQuoteUri = null;

// DOM Elements
const termsInput = document.getElementById('terms');
const minLikesInput = document.getElementById('minLikes');
const timeFilterSelect = document.getElementById('timeFilter');
const sortSelect = document.getElementById('sortSelect');
const searchBtn = document.getElementById('searchBtn');
const statusDiv = document.getElementById('status');
const newPostsDiv = document.getElementById('newPosts');
const resultsDiv = document.getElementById('results');
const autoRefreshToggle = document.getElementById('autoRefreshToggle');
const refreshIntervalSelect = document.getElementById('refreshInterval');
const refreshStateDiv = document.getElementById('refreshState');
const refreshLastDiv = document.getElementById('refreshLast');
const refreshNextDiv = document.getElementById('refreshNext');
const themeSelect = document.getElementById('themeSelect');
const expandTermsToggle = document.getElementById('expandTermsToggle');
const expandSummary = document.getElementById('expandSummary');
const quoteForm = document.getElementById('quoteForm');
const postUrlInput = document.getElementById('postUrl');
const quoteSearchBtn = document.getElementById('quoteSearchBtn');
const quoteStatusDiv = document.getElementById('quoteStatus');
const quoteTabs = document.getElementById('quoteTabs');
const quoteOriginalDiv = document.getElementById('quoteOriginal');
const quoteCountDiv = document.getElementById('quoteCount');
const quoteResultsDiv = document.getElementById('quoteResults');
const quoteLoadMoreDiv = document.getElementById('quoteLoadMore');

// Safe text content setter (prevents XSS)
function setText(element, text) {
    element.textContent = text;
}

// Validate URL is from allowed domains
function isValidBskyUrl(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' &&
            (parsed.hostname === 'bsky.app' ||
                parsed.hostname.endsWith('.bsky.app') ||
                parsed.hostname === 'cdn.bsky.app' ||
                parsed.hostname.endsWith('.cdn.bsky.app'));
    } catch {
        return false;
    }
}

const THEME_STORAGE_KEY = 'bsky-theme';
const prefersDarkScheme = window.matchMedia('(prefers-color-scheme: dark)');

function getSystemTheme() {
    return prefersDarkScheme.matches ? 'dark' : 'light';
}

function applyThemePreference(preference) {
    const resolved = preference === 'system' ? getSystemTheme() : preference;
    document.documentElement.dataset.theme = resolved;
}

function initTheme() {
    const savedPreference = localStorage.getItem(THEME_STORAGE_KEY) || 'system';
    themeSelect.value = savedPreference;
    applyThemePreference(savedPreference);
}


function updateURLWithParams(params) {
    const newURL = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
    window.history.replaceState({}, '', newURL);
}

function setQueryParam(params, key, value) {
    if (value) {
        params.set(key, value);
    } else {
        params.delete(key);
    }
}

function updateSearchURL() {
    const params = new URLSearchParams(window.location.search);
    setQueryParam(params, 'terms', termsInput.value.trim());
    setQueryParam(params, 'minLikes', minLikesInput.value);
    setQueryParam(params, 'time', timeFilterSelect.value !== '24' ? timeFilterSelect.value : '');
    setQueryParam(params, 'sort', searchSort !== 'top' ? searchSort : '');
    setQueryParam(params, 'expand', expandTermsToggle.checked ? '1' : '');
    updateURLWithParams(params);
}

function updateQuoteURL() {
    const params = new URLSearchParams(window.location.search);
    const postValue = postUrlInput.value.trim();
    setQueryParam(params, 'post', postValue);
    if (postValue && quoteSort !== 'likes') {
        params.set('sort', quoteSort);
    } else {
        params.delete('sort');
    }
    updateURLWithParams(params);
}

function updateQuoteTabs() {
    quoteTabs.querySelectorAll('.quote-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.sort === quoteSort);
    });
}

function focusSearchInput() {
    if (!termsInput) return;
    if (typeof termsInput.focus === 'function') {
        termsInput.focus();
    }
    if (typeof termsInput.select === 'function') {
        termsInput.select();
    }
}

// Initialize from URL params
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
    searchSort = sortSelect.value === 'latest' ? 'latest' : 'top';
    if (params.get('expand') === '1') {
        expandTermsToggle.checked = true;
    }

    const postParam = params.get('post');
    const sortParam = params.get('sort');
    if (sortParam && ['likes', 'recent', 'oldest'].includes(sortParam)) {
        quoteSort = sortParam;
        updateQuoteTabs();
    }
    if (postParam) {
        postUrlInput.value = postParam;
        performQuoteSearch();
    }

    updateExpansionSummary();
}

// Show status message
function showStatus(message, type = 'info') {
    statusDiv.className = 'status ' + type;
    setText(statusDiv, message);
    statusDiv.style.display = 'block';
}

function hideStatus() {
    statusDiv.style.display = 'none';
}

function showQuoteStatus(message, type = 'info') {
    quoteStatusDiv.className = 'status ' + type;
    setText(quoteStatusDiv, message);
    quoteStatusDiv.style.display = 'block';
}

function hideQuoteStatus() {
    quoteStatusDiv.style.display = 'none';
}

function normalizeTerm(raw) {
    let term = raw.trim();
    if ((term.startsWith('"') && term.endsWith('"')) || (term.startsWith("'") && term.endsWith("'"))) {
        term = term.slice(1, -1).trim();
    }
    return term;
}

function expandSearchTerms(terms, shouldExpandWords) {
    const expanded = [];
    const seen = new Set();

    const addTerm = (value) => {
        const cleaned = value.trim();
        if (!cleaned) return;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        expanded.push(cleaned);
    };

    terms.forEach((raw) => {
        const term = normalizeTerm(raw);
        if (!term) return;
        addTerm(term);
        if (shouldExpandWords) {
            const parts = term.split(/\s+/).filter(Boolean);
            if (parts.length > 1) {
                parts.forEach(addTerm);
            }
        }
    });

    return expanded;
}

function updateExpansionSummary() {
    const inputValue = termsInput.value.trim();
    if (!inputValue) {
        expandSummary.textContent = 'Enter terms to preview expansion.';
        return;
    }

    const rawTerms = inputValue.split(',').map(normalizeTerm).filter(Boolean);
    if (rawTerms.length === 0) {
        expandSummary.textContent = 'Enter terms to preview expansion.';
        return;
    }

    if (!expandTermsToggle.checked) {
        expandSummary.textContent = `Expansion is off. Searching only: ${rawTerms.join(', ')}`;
        return;
    }

    const expanded = expandSearchTerms(rawTerms, true);
    const rawSet = new Set(rawTerms.map(term => term.toLowerCase()));
    const extras = expanded.filter(term => !rawSet.has(term.toLowerCase()));

    if (extras.length === 0) {
        expandSummary.textContent = `No multi-word phrases detected. Searching: ${rawTerms.join(', ')}`;
        return;
    }

    expandSummary.textContent = `Typed: ${rawTerms.join(', ')}. Expanded: ${expanded.join(', ')}`;
}

// Generate cache key for search requests
function getSearchCacheKey(term, cursor, sort) {
    return JSON.stringify([term, cursor || '', sort]);
}

// Check if cached result is still valid
function getCachedSearch(cacheKey) {
    const cached = searchCache.get(cacheKey);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > SEARCH_CACHE_TTL_MS) {
        searchCache.delete(cacheKey);
        return null;
    }
    return cached.data;
}

// Search posts for a single term (server-side proxy)
async function searchTerm(term, cursor = null, sort = searchSort) {
    const sortValue = sort === 'latest' ? 'latest' : 'top';
    const cacheKey = getSearchCacheKey(term, cursor, sortValue);

    // Check cache first
    const cached = getCachedSearch(cacheKey);
    if (cached) {
        return cached;
    }

    const params = new URLSearchParams({ term, sort: sortValue });
    if (cursor) {
        params.set('cursor', cursor);
    }

    const response = await fetch(`${SEARCH_API}?${params}`);

    if (!response.ok) {
        let errorMsg = `Search failed for "${term}": ${response.status}`;
        try {
            const errorData = await response.json();
            if (errorData.message) errorMsg += ` - ${errorData.message}`;
            if (errorData.error) errorMsg += ` - ${errorData.error}`;
        } catch (e) { }
        throw new Error(errorMsg);
    }

    const data = await response.json();

    // Cache the result
    searchCache.set(cacheKey, { data, timestamp: Date.now() });

    return data;
}

// Fetch all posts for a term (with pagination)
async function fetchAllPostsForTerm(term, maxPages = INITIAL_MAX_PAGES, sort = searchSort) {
    let allTermPosts = [];
    let cursor = null;
    let pages = 0;

    while (pages < maxPages) {
        const data = await searchTerm(term, cursor, sort);

        if (data.posts && data.posts.length > 0) {
            const taggedPosts = data.posts.map(post => ({
                ...post,
                matchedTerm: term
            }));
            allTermPosts = allTermPosts.concat(taggedPosts);
        }

        if (!data.cursor) break;
        cursor = data.cursor;
        pages++;
    }

    currentCursors[term] = cursor;
    return allTermPosts;
}

async function fetchLatestPostsForTerm(term, sort = searchSort) {
    const data = await searchTerm(term, null, sort);
    if (data.posts && data.posts.length > 0) {
        return data.posts.map(post => ({
            ...post,
            matchedTerm: term
        }));
    }
    return [];
}

// Deduplicate posts by URI
function deduplicatePosts(posts) {
    const seen = new Map();

    for (const post of posts) {
        const uri = post.uri;
        if (!seen.has(uri)) {
            seen.set(uri, post);
        } else {
            const existing = seen.get(uri);
            if (!existing.matchedTerms) {
                existing.matchedTerms = [existing.matchedTerm];
            }
            if (!existing.matchedTerms.includes(post.matchedTerm)) {
                existing.matchedTerms.push(post.matchedTerm);
            }
        }
    }

    return Array.from(seen.values()).map(post => {
        if (!post.matchedTerms) {
            post.matchedTerms = [post.matchedTerm];
        }
        return post;
    });
}

// Filter posts by minimum likes
function filterByLikes(posts, minLikes) {
    return posts.filter(post => (post.likeCount || 0) >= minLikes);
}

// Filter posts by date (configurable hours)
function filterByDate(posts, hours) {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - hours);
    return posts.filter(post => {
        const postDate = new Date(post.indexedAt);
        return postDate >= cutoff;
    });
}

// Sort posts by selected mode
function sortPosts(posts, sortMode = searchSort) {
    const sorted = [...posts];
    if (sortMode === 'latest') {
        sorted.sort((a, b) => getPostTimestamp(b) - getPostTimestamp(a));
        return sorted;
    }
    sorted.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
    return sorted;
}

// Format relative time
function formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
}

// Extract post URL from URI
function getPostUrl(post) {
    const parts = post.uri.split('/');
    const postId = parts[parts.length - 1];
    const handle = post.author.handle;
    if (!/^[a-zA-Z0-9._-]+$/.test(handle) || !/^[a-zA-Z0-9]+$/.test(postId)) {
        return null;
    }
    return `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(postId)}`;
}

function formatDateTime(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
}

function getPostTimestamp(post) {
    const candidate = post.record?.createdAt || post.indexedAt;
    const time = new Date(candidate).getTime();
    return Number.isNaN(time) ? 0 : time;
}

function formatTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        return `${hours}h ${mins}m`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function updateRefreshInterval() {
    const minutes = parseInt(refreshIntervalSelect.value, 10);
    refreshIntervalMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : 5 * 60000;
}

function resetRenderLimit() {
    renderLimit = INITIAL_RENDER_LIMIT;
}

function increaseRenderLimit(step = RENDER_STEP) {
    renderLimit = Math.min(allPosts.length, renderLimit + step);
}

function clearRefreshTimers() {
    if (refreshTimerId) {
        clearTimeout(refreshTimerId);
        refreshTimerId = null;
    }
    if (refreshCountdownId) {
        clearInterval(refreshCountdownId);
        refreshCountdownId = null;
    }
}

function updateRefreshMeta() {
    if (autoRefreshEnabled) {
        refreshStateDiv.textContent = isRefreshing ? 'Refreshing...' : 'Auto-refresh on';
    } else {
        refreshStateDiv.textContent = 'Auto-refresh off';
    }

    if (lastRefreshError) {
        refreshLastDiv.textContent = `Last update failed: ${lastRefreshError}`;
    } else if (lastRefreshAt) {
        const suffix = Number.isFinite(lastRefreshNewCount)
            ? ` (+${lastRefreshNewCount} new)`
            : '';
        refreshLastDiv.textContent = `Last updated: ${formatTime(lastRefreshAt)}${suffix}`;
    } else {
        refreshLastDiv.textContent = 'Last updated: --';
    }

    if (autoRefreshEnabled && nextRefreshAt) {
        refreshNextDiv.textContent = `Next refresh in ${formatDuration(nextRefreshAt - Date.now())}`;
    } else {
        refreshNextDiv.textContent = '';
    }
}

function scheduleNextRefresh() {
    clearRefreshTimers();
    if (!autoRefreshEnabled) {
        nextRefreshAt = null;
        updateRefreshMeta();
        return;
    }
    nextRefreshAt = Date.now() + refreshIntervalMs;
    refreshTimerId = setTimeout(runAutoRefresh, refreshIntervalMs);
    refreshCountdownId = setInterval(updateRefreshMeta, 1000);
    updateRefreshMeta();
}

function clearNewPostHighlights() {
    newPostUris.clear();
    if (clearHighlightsTimeout) {
        clearTimeout(clearHighlightsTimeout);
        clearHighlightsTimeout = null;
    }
}

function scheduleNewPostHighlightClear() {
    if (clearHighlightsTimeout) {
        clearTimeout(clearHighlightsTimeout);
    }
    clearHighlightsTimeout = setTimeout(() => {
        newPostUris.clear();
        clearHighlightsTimeout = null;
        renderResults();
    }, 8000);
}

function updateQuoteCount() {
    if (Number.isFinite(quoteTotalCount)) {
        const total = quoteTotalCount;
        quoteCountDiv.textContent = `Loaded ${allQuotes.length} of ${total} quote${total !== 1 ? 's' : ''}`;
        return;
    }
    quoteCountDiv.textContent = `Loaded ${allQuotes.length} quote${allQuotes.length !== 1 ? 's' : ''}`;
}

function trackQuoteCursor(nextCursor) {
    if (!nextCursor) {
        return null;
    }
    if (quoteSeenCursors.has(nextCursor)) {
        return null;
    }
    quoteSeenCursors.add(nextCursor);
    return nextCursor;
}

function parseBlueskyPostUrl(urlString) {
    let parsedUrl;
    try {
        parsedUrl = new URL(urlString);
    } catch (e) {
        throw new Error('Please enter a valid URL.');
    }

    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'bsky.app') {
        throw new Error('URL must be from https://bsky.app');
    }

    const parts = parsedUrl.pathname.split('/').filter(Boolean);
    if (parts.length < 4 || parts[0] !== 'profile' || parts[2] !== 'post') {
        throw new Error('Use https://bsky.app/profile/{handle}/post/{postId}');
    }

    const rawHandle = parts[1];
    const postId = parts[3];
    if (!rawHandle || !postId) {
        throw new Error('URL is missing a handle or post ID.');
    }

    const actor = rawHandle.startsWith('did:')
        ? rawHandle
        : (rawHandle.includes('.') ? rawHandle : `${rawHandle}.bsky.social`);
    return { actor, postId, rawHandle };
}

async function fetchDid(actor) {
    // Check cache first
    const cacheKey = actor.toLowerCase();
    if (didCache.has(cacheKey)) {
        return didCache.get(cacheKey);
    }

    const response = await fetch(
        `${PUBLIC_API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`
    );
    if (!response.ok) {
        throw new Error(`Profile fetch failed: ${response.status}`);
    }
    const data = await response.json();
    const did = data.did || data.profile?.did;
    if (!did) {
        throw new Error('Could not resolve DID for that handle.');
    }

    // Cache the result
    didCache.set(cacheKey, did);
    return did;
}

async function fetchOriginalPost(atUri) {
    const response = await fetch(
        `${PUBLIC_API}/app.bsky.feed.getPosts?uris=${encodeURIComponent(atUri)}`
    );
    if (!response.ok) {
        throw new Error(`Original post fetch failed: ${response.status}`);
    }
    const data = await response.json();
    if (!data.posts || data.posts.length === 0) {
        throw new Error('Post not found.');
    }
    return data.posts[0];
}

async function fetchQuotesPage(atUri, cursor = null) {
    let url = `${PUBLIC_API}/app.bsky.feed.getQuotes?uri=${encodeURIComponent(atUri)}&limit=100`;
    if (cursor) {
        url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Quotes fetch failed: ${response.status}`);
    }
    const data = await response.json();
    return {
        posts: Array.isArray(data.posts) ? data.posts : [],
        cursor: data.cursor || null
    };
}

function sortQuotes(quotes, sortMode) {
    const sorted = [...quotes];
    switch (sortMode) {
        case 'likes':
            sorted.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
            break;
        case 'recent':
            sorted.sort((a, b) => getPostTimestamp(b) - getPostTimestamp(a));
            break;
        case 'oldest':
            sorted.sort((a, b) => getPostTimestamp(a) - getPostTimestamp(b));
            break;
        default:
            break;
    }
    return sorted;
}

function createQuoteOriginalElement(post) {
    const wrapper = document.createElement('div');
    wrapper.className = 'quote-original';

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = 'Original Post';
    wrapper.appendChild(label);

    const author = document.createElement('div');
    author.className = 'quote-author';
    const authorName = post.author.displayName || post.author.handle;
    author.textContent = `${authorName} (@${post.author.handle})`;
    wrapper.appendChild(author);

    const meta = document.createElement('div');
    meta.className = 'quote-meta';
    const time = document.createElement('span');
    time.textContent = formatDateTime(post.record?.createdAt || post.indexedAt);
    meta.appendChild(time);
    wrapper.appendChild(meta);

    const postUrl = getPostUrl(post);
    if (postUrl) {
        const actions = document.createElement('div');
        actions.className = 'link-actions';

        const link = document.createElement('a');
        link.className = 'thread-link';
        link.href = postUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'View on Bluesky';
        actions.appendChild(link);

        wrapper.appendChild(actions);
    }

    const text = document.createElement('div');
    text.className = 'quote-text';
    text.textContent = post.record?.text || '';
    wrapper.appendChild(text);

    const stats = document.createElement('div');
    stats.className = 'quote-stats';

    const likeStat = document.createElement('span');
    likeStat.className = 'quote-stat likes';
    likeStat.textContent = `♥ ${post.likeCount || 0}`;
    stats.appendChild(likeStat);

    const repostStat = document.createElement('span');
    repostStat.className = 'quote-stat reposts';
    repostStat.textContent = `↻ ${post.repostCount || 0}`;
    stats.appendChild(repostStat);

    const replyStat = document.createElement('span');
    replyStat.className = 'quote-stat replies';
    replyStat.textContent = `💬 ${post.replyCount || 0}`;
    stats.appendChild(replyStat);

    const quoteStat = document.createElement('span');
    quoteStat.className = 'quote-stat';
    quoteStat.textContent = `Quotes ${post.quoteCount || 0}`;
    stats.appendChild(quoteStat);

    wrapper.appendChild(stats);
    return wrapper;
}

function createQuotePostElement(post, index) {
    const wrapper = document.createElement('div');
    wrapper.className = `quote-post depth-${(index % 8) + 1}`;

    const author = document.createElement('div');
    author.className = 'quote-author';
    const authorName = post.author.displayName || post.author.handle;
    author.textContent = `${authorName} (@${post.author.handle})`;
    wrapper.appendChild(author);

    const meta = document.createElement('div');
    meta.className = 'quote-meta';
    const time = document.createElement('span');
    time.textContent = formatDateTime(post.record?.createdAt || post.indexedAt);
    meta.appendChild(time);
    wrapper.appendChild(meta);

    const postUrl = getPostUrl(post);
    if (postUrl) {
        const actions = document.createElement('div');
        actions.className = 'link-actions';

        const link = document.createElement('a');
        link.className = 'thread-link';
        link.href = postUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'View on Bluesky';
        actions.appendChild(link);

        wrapper.appendChild(actions);
    }

    const text = document.createElement('div');
    text.className = 'quote-text';
    text.textContent = post.record?.text || '';
    wrapper.appendChild(text);

    const stats = document.createElement('div');
    stats.className = 'quote-stats';

    const likeStat = document.createElement('span');
    likeStat.className = 'quote-stat likes';
    likeStat.textContent = `♥ ${post.likeCount || 0}`;
    stats.appendChild(likeStat);

    const repostStat = document.createElement('span');
    repostStat.className = 'quote-stat reposts';
    repostStat.textContent = `↻ ${post.repostCount || 0}`;
    stats.appendChild(repostStat);

    const replyStat = document.createElement('span');
    replyStat.className = 'quote-stat replies';
    replyStat.textContent = `💬 ${post.replyCount || 0}`;
    stats.appendChild(replyStat);

    wrapper.appendChild(stats);
    return wrapper;
}

function renderQuoteLoadMore() {
    quoteLoadMoreDiv.textContent = '';
    if (!quoteCursor) {
        return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'load-more';
    button.id = 'quoteLoadMoreBtn';
    button.textContent = 'Load More Quotes';
    button.disabled = isQuoteLoading;
    button.addEventListener('click', loadMoreQuotes);
    quoteLoadMoreDiv.appendChild(button);
}

function renderQuoteResults() {
    quoteResultsDiv.textContent = '';
    if (allQuotes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'no-quotes';
        empty.textContent = 'No quotes found for this post.';
        quoteResultsDiv.appendChild(empty);
        return;
    }

    const sorted = sortQuotes(allQuotes, quoteSort);
    sorted.forEach((quote, index) => {
        quoteResultsDiv.appendChild(createQuotePostElement(quote, index));
    });
}

async function loadMoreQuotes() {
    if (isQuoteLoading || !activeQuoteUri || !quoteCursor) {
        return;
    }

    isQuoteLoading = true;
    const loadMoreBtn = document.getElementById('quoteLoadMoreBtn');
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.textContent = 'Loading...';
    }

    try {
        const page = await fetchQuotesPage(activeQuoteUri, quoteCursor);
        if (page.posts.length > 0) {
            allQuotes = allQuotes.concat(page.posts);
        }
        quoteCursor = trackQuoteCursor(page.cursor);
        updateQuoteCount();
        renderQuoteResults();
        hideQuoteStatus();
    } catch (error) {
        console.error('Load more quotes error:', error);
        showQuoteStatus(`Error loading more quotes: ${error.message}`, 'error');
    } finally {
        isQuoteLoading = false;
        renderQuoteLoadMore();
    }
}

async function performQuoteSearch() {
    if (isQuoteLoading) return;

    const urlValue = postUrlInput.value.trim();
    if (!urlValue) {
        showQuoteStatus('Please enter a Bluesky post URL.', 'error');
        return;
    }

    isQuoteLoading = true;
    quoteSearchBtn.disabled = true;
    showQuoteStatus('Loading quotes...', 'loading');
    quoteTabs.style.display = 'none';
    quoteResultsDiv.textContent = '';
    quoteOriginalDiv.textContent = '';
    quoteCountDiv.textContent = '';
    quoteLoadMoreDiv.textContent = '';
    allQuotes = [];
    quoteCursor = null;
    quoteSeenCursors = new Set();
    quoteTotalCount = null;
    activeQuoteUri = null;

    updateQuoteURL();

    try {
        const { actor, postId } = parseBlueskyPostUrl(urlValue);
        const did = await fetchDid(actor);
        const atUri = `at://${did}/app.bsky.feed.post/${postId}`;

        activeQuoteUri = atUri;

        const [post, quotePage] = await Promise.all([
            fetchOriginalPost(atUri),
            fetchQuotesPage(atUri)
        ]);

        allQuotes = quotePage.posts;
        quoteCursor = trackQuoteCursor(quotePage.cursor);
        if (Number.isFinite(post.quoteCount) && post.quoteCount >= allQuotes.length) {
            quoteTotalCount = post.quoteCount;
        }

        quoteOriginalDiv.appendChild(createQuoteOriginalElement(post));
        updateQuoteCount();
        quoteTabs.style.display = 'flex';
        hideQuoteStatus();
        renderQuoteResults();
    } catch (error) {
        console.error('Quote search error:', error);
        showQuoteStatus(`Error: ${error.message}`, 'error');
    } finally {
        isQuoteLoading = false;
        quoteSearchBtn.disabled = false;
        renderQuoteLoadMore();
    }
}

// Thread Explorer functions
function isReplyPost(post) {
    return !!(post.record?.reply);
}

async function fetchPostThread(atUri) {
    const params = new URLSearchParams({
        uri: atUri,
        depth: '0',
        parentHeight: '100'
    });
    const response = await fetch(`${PUBLIC_API}/app.bsky.feed.getPostThread?${params}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch thread: ${response.status}`);
    }
    return response.json();
}

function extractParentChain(thread) {
    const parents = [];
    let current = thread.thread?.parent;
    while (current?.post) {
        parents.unshift(current.post);
        current = current.parent;
    }
    return parents;
}

function createThreadParentElement(post) {
    const wrapper = document.createElement('div');
    wrapper.className = 'thread-parent';

    const header = document.createElement('div');
    header.className = 'thread-parent-header';

    if (post.author.avatar && isValidBskyUrl(post.author.avatar)) {
        const avatar = document.createElement('img');
        avatar.className = 'thread-parent-avatar';
        avatar.src = post.author.avatar;
        avatar.alt = '';
        avatar.loading = 'lazy';
        header.appendChild(avatar);
    } else {
        const avatarPlaceholder = document.createElement('div');
        avatarPlaceholder.className = 'thread-parent-avatar';
        header.appendChild(avatarPlaceholder);
    }

    const authorSpan = document.createElement('span');
    authorSpan.className = 'thread-parent-author';
    authorSpan.textContent = post.author.displayName || post.author.handle;
    header.appendChild(authorSpan);

    const handleSpan = document.createElement('span');
    handleSpan.className = 'thread-parent-handle';
    handleSpan.textContent = `@${post.author.handle}`;
    header.appendChild(handleSpan);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'thread-parent-time';
    timeSpan.textContent = formatRelativeTime(post.indexedAt);
    header.appendChild(timeSpan);

    wrapper.appendChild(header);

    const textDiv = document.createElement('div');
    textDiv.className = 'thread-parent-text';
    textDiv.textContent = post.record?.text || '';
    wrapper.appendChild(textDiv);

    return wrapper;
}

function createThreadContextElement(parents) {
    const container = document.createElement('div');
    container.className = 'thread-context';

    const label = document.createElement('div');
    label.className = 'thread-label';
    label.textContent = 'Thread context';
    container.appendChild(label);

    parents.forEach(parent => {
        container.appendChild(createThreadParentElement(parent));
    });

    return container;
}

function removeThreadContexts(postElement) {
    let previous = postElement.previousElementSibling;
    let removed = false;

    while (previous?.classList.contains('thread-context')) {
        const toRemove = previous;
        previous = previous.previousElementSibling;
        toRemove.remove();
        removed = true;
    }

    return removed;
}

async function toggleThread(post, postElement) {
    const link = postElement.querySelector('.thread-link');
    if (!link) return;

    if (link.dataset.loading === 'true') {
        return;
    }

    if (removeThreadContexts(postElement)) {
        link.textContent = 'View Thread';
        return;
    }

    link.dataset.loading = 'true';
    link.disabled = true;
    link.textContent = 'Loading...';

    try {
        const threadData = await fetchPostThread(post.uri);
        const parents = extractParentChain(threadData);

        if (parents.length === 0) {
            if (link) link.textContent = 'No parent posts found';
            setTimeout(() => {
                if (link) link.textContent = 'View Thread';
            }, 2000);
            return;
        }

        const contextElement = createThreadContextElement(parents);
        postElement.parentNode.insertBefore(contextElement, postElement);
        link.textContent = 'Hide Thread';
    } catch (error) {
        console.error('Thread fetch error:', error);
        link.textContent = 'Failed to load thread';
        setTimeout(() => {
            link.textContent = 'View Thread';
        }, 2000);
    } finally {
        link.dataset.loading = 'false';
        link.disabled = false;
    }
}

// Create text with highlighted search terms using DOM methods (safe)
function createHighlightedText(text, terms) {
    const fragment = document.createDocumentFragment();
    if (!text) return fragment;

    const escapedTerms = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');

    const parts = text.split(regex);

    parts.forEach(part => {
        if (terms.some(term => part.toLowerCase() === term.toLowerCase())) {
            const span = document.createElement('span');
            span.className = 'highlight';
            span.textContent = part;
            fragment.appendChild(span);
        } else {
            fragment.appendChild(document.createTextNode(part));
        }
    });

    return fragment;
}

// Create a post element using safe DOM methods
function createPostElement(post) {
    const postUrl = getPostUrl(post);
    const handle = post.author.handle;
    const displayName = post.author.displayName || handle;
    const text = post.record?.text || '';

    const postDiv = document.createElement('div');
    postDiv.className = 'post';
    if (newPostUris.has(post.uri)) {
        postDiv.classList.add('new-post');
    }

    // Search terms tags
    const termsDiv = document.createElement('div');
    termsDiv.className = 'search-terms';
    post.matchedTerms.forEach(term => {
        const tag = document.createElement('span');
        tag.className = 'term-tag';
        tag.textContent = term;
        termsDiv.appendChild(tag);
    });
    postDiv.appendChild(termsDiv);

    // Header
    const header = document.createElement('div');
    header.className = 'post-header';

    // Avatar
    if (post.author.avatar && isValidBskyUrl(post.author.avatar)) {
        const avatar = document.createElement('img');
        avatar.className = 'avatar';
        avatar.src = post.author.avatar;
        avatar.alt = '';
        avatar.loading = 'lazy';
        header.appendChild(avatar);
    } else {
        const avatarPlaceholder = document.createElement('div');
        avatarPlaceholder.className = 'avatar';
        header.appendChild(avatarPlaceholder);
    }

    // Author info
    const authorInfo = document.createElement('div');
    authorInfo.className = 'author-info';

    const authorUrl = `https://bsky.app/profile/${encodeURIComponent(handle)}`;
    const nameLink = document.createElement('a');
    nameLink.className = 'display-name';
    nameLink.href = authorUrl;
    nameLink.target = '_blank';
    nameLink.rel = 'noopener noreferrer';
    nameLink.textContent = displayName;
    authorInfo.appendChild(nameLink);

    const handleSpan = document.createElement('span');
    handleSpan.className = 'handle';
    handleSpan.textContent = `@${handle}`;
    authorInfo.appendChild(handleSpan);

    header.appendChild(authorInfo);

    // Time
    const timeSpan = document.createElement('span');
    timeSpan.className = 'post-time';
    timeSpan.textContent = formatRelativeTime(post.indexedAt);
    header.appendChild(timeSpan);

    postDiv.appendChild(header);

    // Post text with highlights
    const textDiv = document.createElement('div');
    textDiv.className = 'post-text';
    textDiv.appendChild(createHighlightedText(text, searchTerms));
    postDiv.appendChild(textDiv);

    // Images (hidden by default)
    if (post.embed?.$type === 'app.bsky.embed.images#view' && post.embed.images) {
        const validImages = post.embed.images.filter(img => img.thumb && isValidBskyUrl(img.thumb));

        if (validImages.length > 0) {
            const imagesContainer = document.createElement('div');
            imagesContainer.className = 'post-images-container';

            // Create placeholder
            const placeholder = document.createElement('div');
            placeholder.className = 'image-placeholder';

            const showBtn = document.createElement('button');
            showBtn.type = 'button';
            const count = validImages.length;
            showBtn.textContent = `Show ${count} image${count !== 1 ? 's' : ''}`;
            showBtn.addEventListener('click', () => {
                // Replace placeholder with actual images
                const imagesDiv = document.createElement('div');
                imagesDiv.className = 'post-images ' + (validImages.length === 1 ? 'single' : 'multiple');

                validImages.forEach(img => {
                    const imgEl = document.createElement('img');
                    imgEl.className = 'post-image';
                    imgEl.src = img.thumb;
                    imgEl.alt = img.alt || '';
                    imgEl.loading = 'lazy';
                    imagesDiv.appendChild(imgEl);
                });

                imagesContainer.replaceChild(imagesDiv, placeholder);
            });

            placeholder.appendChild(showBtn);
            imagesContainer.appendChild(placeholder);
            postDiv.appendChild(imagesContainer);
        }
    }

    // Stats
    const statsDiv = document.createElement('div');
    statsDiv.className = 'post-stats';

    const likeStat = document.createElement('span');
    likeStat.className = 'stat likes';
    likeStat.textContent = `♥ ${post.likeCount || 0}`;
    statsDiv.appendChild(likeStat);

    const repostStat = document.createElement('span');
    repostStat.className = 'stat';
    repostStat.textContent = `↻ ${post.repostCount || 0}`;
    statsDiv.appendChild(repostStat);

    const replyStat = document.createElement('span');
    replyStat.className = 'stat';
    replyStat.textContent = `💬 ${post.replyCount || 0}`;
    statsDiv.appendChild(replyStat);

    postDiv.appendChild(statsDiv);

    // Links container
    const linksDiv = document.createElement('div');
    linksDiv.className = 'link-actions';

    // Thread link (View Thread for replies, View Replies for standalone posts)
    if (postUrl) {
        if (isReplyPost(post)) {
            const threadLink = document.createElement('button');
            threadLink.className = 'thread-link';
            threadLink.textContent = 'View Thread';
            threadLink.addEventListener('click', () => toggleThread(post, postDiv));
            linksDiv.appendChild(threadLink);

            const blueskyLink = document.createElement('a');
            blueskyLink.className = 'thread-link';
            blueskyLink.href = postUrl;
            blueskyLink.target = '_blank';
            blueskyLink.rel = 'noopener noreferrer';
            blueskyLink.textContent = 'View on Bluesky';
            linksDiv.appendChild(blueskyLink);
        } else {
            const repliesLink = document.createElement('a');
            repliesLink.className = 'thread-link';
            repliesLink.href = postUrl;
            repliesLink.target = '_blank';
            repliesLink.rel = 'noopener noreferrer';
            repliesLink.textContent = 'View Replies →';
            linksDiv.appendChild(repliesLink);
        }
    }

    postDiv.appendChild(linksDiv);

    return postDiv;
}

// Render all results using safe DOM methods
function renderResults() {
    resultsDiv.textContent = '';

    if (allPosts.length === 0) {
        const noResults = document.createElement('div');
        noResults.className = 'no-results';

        const p1 = document.createElement('p');
        p1.textContent = pendingPosts.length > 0
            ? 'New posts are waiting above.'
            : 'No posts found matching your criteria.';
        noResults.appendChild(p1);

        const p2 = document.createElement('p');
        p2.textContent = pendingPosts.length > 0
            ? 'Use "Add to results" to merge them into the main list.'
            : 'Try different search terms or lower the minimum likes.';
        noResults.appendChild(p2);

        resultsDiv.appendChild(noResults);
        return;
    }

    // Header
    const headerDiv = document.createElement('div');
    headerDiv.className = 'results-header';

    const countSpan = document.createElement('span');
    countSpan.className = 'results-count';
    const totalCount = allPosts.length;
    const visibleCount = Math.min(renderLimit, totalCount);
    const totalLabel = totalCount === 1 ? 'post' : 'posts';
    if (visibleCount < totalCount) {
        countSpan.textContent = `Showing ${visibleCount} of ${totalCount} ${totalLabel}`;
    } else {
        countSpan.textContent = `${totalCount} ${totalLabel} found`;
    }
    headerDiv.appendChild(countSpan);

    const sortSpan = document.createElement('span');
    sortSpan.textContent = searchSort === 'latest'
        ? 'Sorted by time (newest first)'
        : 'Sorted by likes (high to low)';
    headerDiv.appendChild(sortSpan);

    resultsDiv.appendChild(headerDiv);

    // Posts
    const visiblePosts = allPosts.slice(0, visibleCount);
    visiblePosts.forEach(post => {
        resultsDiv.appendChild(createPostElement(post));
    });

    if (visibleCount < totalCount) {
        const showMoreBtn = document.createElement('button');
        showMoreBtn.className = 'load-more';
        showMoreBtn.id = 'showMoreBtn';
        const remaining = totalCount - visibleCount;
        if (remaining <= RENDER_STEP) {
            showMoreBtn.textContent = remaining === 1
                ? 'Show 1 more loaded result'
                : `Show ${remaining} more loaded results`;
        } else {
            showMoreBtn.textContent = `Show ${RENDER_STEP} more loaded results`;
        }
        showMoreBtn.addEventListener('click', () => {
            increaseRenderLimit();
            renderResults();
        });
        resultsDiv.appendChild(showMoreBtn);
    }

    // Load more button
    const hasMoreResults = Object.values(currentCursors).some(cursor => cursor !== null);
    if (hasMoreResults) {
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'load-more';
        loadMoreBtn.id = 'loadMoreBtn';
        loadMoreBtn.textContent = 'Load More Results';
        loadMoreBtn.addEventListener('click', loadMore);
        resultsDiv.appendChild(loadMoreBtn);
    }
}

function renderNewPosts() {
    newPostsDiv.textContent = '';
    if (pendingPosts.length === 0) {
        newPostsDiv.classList.add('hidden');
        return;
    }

    newPostsDiv.classList.remove('hidden');

    const header = document.createElement('div');
    header.className = 'new-posts-header';

    const title = document.createElement('div');
    title.className = 'new-posts-title';
    title.textContent = `${pendingPosts.length} new post${pendingPosts.length !== 1 ? 's' : ''} from auto-refresh`;
    header.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'new-posts-actions';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'button-small';
    addBtn.textContent = 'Add to results';
    addBtn.addEventListener('click', mergePendingPosts);
    actions.appendChild(addBtn);

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'button-secondary button-small';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', dismissPendingPosts);
    actions.appendChild(dismissBtn);

    header.appendChild(actions);
    newPostsDiv.appendChild(header);

    const list = document.createElement('div');
    list.className = 'new-posts-list';
    const sorted = [...pendingPosts].sort((a, b) => getPostTimestamp(b) - getPostTimestamp(a));
    sorted.forEach(post => {
        list.appendChild(createPostElement(post));
    });
    newPostsDiv.appendChild(list);
}

function mergePendingPosts() {
    if (pendingPosts.length === 0) {
        return;
    }

    let combined = deduplicatePosts([...pendingPosts, ...allPosts]);
    combined = filterByDate(combined, timeFilterHours);
    combined = filterByLikes(combined, minLikes);
    allPosts = sortPosts(combined);

    clearNewPostHighlights();
    newPostUris = new Set(pendingPosts.map(post => post.uri));
    scheduleNewPostHighlightClear();
    pendingPosts = [];
    renderNewPosts();
    renderResults();
}

function dismissPendingPosts() {
    if (pendingPosts.length === 0) {
        return;
    }
    pendingPosts = [];
    clearNewPostHighlights();
    renderNewPosts();
    renderResults();
}

async function refreshSearch() {
    if (searchTerms.length === 0) {
        return 0;
    }

    let trimmed = filterByDate(allPosts, timeFilterHours);
    trimmed = filterByLikes(trimmed, minLikes);
    allPosts = sortPosts(trimmed);

    pendingPosts = filterByDate(pendingPosts, timeFilterHours);
    pendingPosts = filterByLikes(pendingPosts, minLikes);

    const existingUris = new Set([...allPosts, ...pendingPosts].map(post => post.uri));
    const results = await Promise.all(searchTerms.map(term => fetchLatestPostsForTerm(term, searchSort)));
    let latestPosts = deduplicatePosts(results.flat());
    latestPosts = filterByDate(latestPosts, timeFilterHours);
    latestPosts = filterByLikes(latestPosts, minLikes);

    const newPosts = latestPosts.filter(post => !existingUris.has(post.uri));

    if (newPosts.length > 0) {
        pendingPosts = deduplicatePosts([...pendingPosts, ...newPosts]);
    }

    clearNewPostHighlights();
    if (newPosts.length > 0) {
        newPostUris = new Set(newPosts.map(post => post.uri));
        scheduleNewPostHighlightClear();
    }

    renderNewPosts();
    renderResults();
    return newPosts.length;
}

async function runAutoRefresh() {
    if (!autoRefreshEnabled) {
        return;
    }
    if (isLoading || isRefreshing) {
        scheduleNextRefresh();
        return;
    }
    if (searchTerms.length === 0) {
        autoRefreshEnabled = false;
        autoRefreshToggle.checked = false;
        nextRefreshAt = null;
        lastRefreshError = 'Run a search first.';
        updateRefreshMeta();
        clearRefreshTimers();
        return;
    }

    isRefreshing = true;
    lastRefreshError = null;
    lastRefreshNewCount = null;
    updateRefreshMeta();

    try {
        const newCount = await refreshSearch();
        lastRefreshAt = new Date();
        lastRefreshNewCount = newCount;
    } catch (error) {
        console.error('Auto-refresh error:', error);
        lastRefreshError = error.message || 'Refresh failed.';
    } finally {
        isRefreshing = false;
        scheduleNextRefresh();
    }
}

function enableAutoRefresh() {
    if (searchTerms.length === 0) {
        autoRefreshToggle.checked = false;
        lastRefreshError = 'Run a search first.';
        updateRefreshMeta();
        return;
    }
    autoRefreshEnabled = true;
    lastRefreshError = null;
    updateRefreshInterval();
    scheduleNextRefresh();
}

function disableAutoRefresh() {
    autoRefreshEnabled = false;
    clearRefreshTimers();
    nextRefreshAt = null;
    updateRefreshMeta();
}

// Main search function
async function performSearch() {
    if (isLoading) {
        pendingSearch = true;
        return;
    }
    pendingSearch = false;
    const termsValue = termsInput.value.trim();
    if (!termsValue) {
        showStatus('Please enter at least one search term.', 'error');
        return;
    }

    rawSearchTerms = termsValue.split(',').map(normalizeTerm).filter(t => t.length > 0);
    searchTerms = expandSearchTerms(rawSearchTerms, expandTermsToggle.checked);
    minLikes = parseInt(minLikesInput.value) || 0;
    timeFilterHours = parseInt(timeFilterSelect.value) || 24;
    searchSort = sortSelect.value === 'latest' ? 'latest' : 'top';

    if (rawSearchTerms.length === 0) {
        showStatus('Please enter at least one search term.', 'error');
        return;
    }

    isLoading = true;
    searchBtn.disabled = true;
    let searchCompleted = false;
    allPosts = [];
    currentCursors = {};
    resultsDiv.textContent = '';
    clearNewPostHighlights();
    pendingPosts = [];
    renderNewPosts();
    resetRenderLimit();

    updateSearchURL();

    try {
        showStatus(`Searching for: ${rawSearchTerms.join(', ')}...`, 'loading');

        // Fetch all terms in parallel (Bluesky API doesn't support OR queries)
        const promises = searchTerms.map(term => fetchAllPostsForTerm(term, INITIAL_MAX_PAGES, searchSort));
        const results = await Promise.all(promises);
        let combinedPosts = results.flat();

        combinedPosts = deduplicatePosts(combinedPosts);
        combinedPosts = filterByDate(combinedPosts, timeFilterHours);
        combinedPosts = filterByLikes(combinedPosts, minLikes);
        allPosts = sortPosts(combinedPosts);

        lastRefreshAt = new Date();
        lastRefreshNewCount = null;
        lastRefreshError = null;
        searchCompleted = true;
        updateRefreshMeta();

        hideStatus();
        renderResults();

    } catch (error) {
        console.error('Search error:', error);
        showStatus(`Error: ${error.message}`, 'error');
    } finally {
        isLoading = false;
        searchBtn.disabled = false;
        if (autoRefreshEnabled && searchCompleted) {
            scheduleNextRefresh();
        }
        if (pendingSearch) {
            pendingSearch = false;
            performSearch();
        }
    }
}

// Load more results
async function loadMore() {
    if (isLoading) return;

    const prevCount = allPosts.length;
    isLoading = true;
    const loadMoreBtn = document.getElementById('loadMoreBtn');
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.textContent = 'Loading...';
    }

    try {
        const promises = searchTerms
            .filter(term => currentCursors[term])
            .map(async term => {
                const data = await searchTerm(term, currentCursors[term], searchSort);
                currentCursors[term] = data.cursor || null;

                if (data.posts && data.posts.length > 0) {
                    return data.posts.map(post => ({
                        ...post,
                        matchedTerm: term
                    }));
                }
                return [];
            });

        const results = await Promise.all(promises);
        let newPosts = results.flat();

        if (newPosts.length > 0) {
            let combined = [...allPosts, ...newPosts];
            combined = deduplicatePosts(combined);
            combined = filterByDate(combined, timeFilterHours);
            combined = filterByLikes(combined, minLikes);
            allPosts = sortPosts(combined);
            if (allPosts.length > prevCount) {
                renderLimit = Math.min(allPosts.length, renderLimit + RENDER_STEP);
            }
            renderResults();
        } else {
            if (loadMoreBtn) {
                loadMoreBtn.remove();
            }
        }

    } catch (error) {
        console.error('Load more error:', error);
        showStatus(`Error loading more: ${error.message}`, 'error');
    } finally {
        isLoading = false;
    }
}

// Event listeners
searchBtn.addEventListener('click', () => {
    cancelDebouncedSearch();
    performSearch();
});
quoteForm.addEventListener('submit', (e) => {
    e.preventDefault();
    performQuoteSearch();
});
themeSelect.addEventListener('change', (e) => {
    const preference = e.target.value;
    localStorage.setItem(THEME_STORAGE_KEY, preference);
    applyThemePreference(preference);
});
prefersDarkScheme.addEventListener('change', () => {
    if (themeSelect.value === 'system') {
        applyThemePreference('system');
    }
});
autoRefreshToggle.addEventListener('change', (e) => {
    if (e.target.checked) {
        enableAutoRefresh();
    } else {
        disableAutoRefresh();
    }
});
refreshIntervalSelect.addEventListener('change', () => {
    updateRefreshInterval();
    if (autoRefreshEnabled) {
        scheduleNextRefresh();
    } else {
        updateRefreshMeta();
    }
});
sortSelect.addEventListener('change', () => {
    searchSort = sortSelect.value === 'latest' ? 'latest' : 'top';
    if (autoRefreshEnabled) {
        scheduleNextRefresh();
    }
});
quoteTabs.addEventListener('click', (e) => {
    if (!e.target.classList.contains('quote-tab')) return;
    const nextSort = e.target.dataset.sort;
    if (nextSort && nextSort !== quoteSort) {
        quoteSort = nextSort;
        updateQuoteTabs();
        updateQuoteURL();
        renderQuoteResults();
    }
});

function debouncedSearch() {
    if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
    }
    searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = null;
        performSearch();
    }, SEARCH_DEBOUNCE_MS);
}

function cancelDebouncedSearch() {
    if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
    }
}

termsInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        cancelDebouncedSearch();
        performSearch();
    }
});
termsInput.addEventListener('input', () => {
    updateExpansionSummary();
    if (!termsInput.value.trim()) {
        cancelDebouncedSearch();
        pendingSearch = false;
        return;
    }
    debouncedSearch();
});

minLikesInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
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

// Export for testing (no-op in browser)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        isValidBskyUrl,
        parseBlueskyPostUrl,
        deduplicatePosts,
        trackQuoteCursor,
        getSearchCacheKey,
        filterByLikes,
        sortPosts,
        normalizeTerm,
        expandSearchTerms,
        formatDuration,
    };
}

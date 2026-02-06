import { isValidBskyUrl, setText } from './utils.mjs';

/**
 * Create a single stat element (likes, reposts, replies, etc.)
 * @param {string} className - CSS class(es) for the stat span
 * @param {string} icon - Icon character (e.g. '♥ ', '↻ ', '💬 ')
 * @param {number} count - The stat count
 * @param {string} label - Accessible label (e.g. 'likes', 'reposts')
 */
export function createStatElement(className, icon, count, label) {
  const stat = document.createElement('span');
  stat.className = className;
  stat.setAttribute('aria-label', `${count} ${label}`);

  const iconSpan = document.createElement('span');
  iconSpan.setAttribute('aria-hidden', 'true');
  iconSpan.textContent = icon;
  stat.appendChild(iconSpan);

  stat.appendChild(document.createTextNode(count));
  return stat;
}

/**
 * Create a full stats bar for a post.
 * @param {Object} post - Post object with likeCount, repostCount, replyCount, quoteCount
 * @param {Object} [options]
 * @param {string} [options.statPrefix='stat'] - CSS class prefix ('stat' or 'quote-stat')
 * @param {string} [options.containerClass='post-stats'] - Container CSS class
 * @param {boolean} [options.showQuotes=false] - Whether to show quote count
 */
export function createStatsBar(post, options = {}) {
  const {
    statPrefix = 'stat',
    containerClass = 'post-stats',
    showQuotes = false,
  } = options;

  const stats = document.createElement('div');
  stats.className = containerClass;

  stats.appendChild(
    createStatElement(`${statPrefix} likes`, '\u2665 ', post.likeCount || 0, 'likes')
  );
  stats.appendChild(
    createStatElement(`${statPrefix} reposts`, '\u21bb ', post.repostCount || 0, 'reposts')
  );
  stats.appendChild(
    createStatElement(`${statPrefix} replies`, '\ud83d\udcac ', post.replyCount || 0, 'replies')
  );

  if (showQuotes) {
    const quoteStat = document.createElement('span');
    quoteStat.className = statPrefix;
    quoteStat.textContent = `Quotes ${post.quoteCount || 0}`;
    stats.appendChild(quoteStat);
  }

  return stats;
}

/**
 * Create an author header with avatar, name, handle, and optional time.
 * @param {Object} post - Post object with author info
 * @param {Object} [options]
 * @param {string} [options.timeText] - Formatted time string to display
 * @param {boolean} [options.linkName=true] - Whether to make the display name a link
 */
export function createAuthorHeader(post, options = {}) {
  const { timeText, linkName = true } = options;
  const handle = post.author.handle;
  const displayName = post.author.displayName || handle;

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

  if (linkName) {
    const authorUrl = `https://bsky.app/profile/${encodeURIComponent(handle)}`;
    const nameLink = document.createElement('a');
    nameLink.className = 'display-name';
    nameLink.href = authorUrl;
    nameLink.target = '_blank';
    nameLink.rel = 'noopener noreferrer';
    nameLink.textContent = displayName;
    authorInfo.appendChild(nameLink);
  } else {
    const nameSpan = document.createElement('span');
    nameSpan.className = 'display-name';
    nameSpan.textContent = displayName;
    authorInfo.appendChild(nameSpan);
  }

  const handleSpan = document.createElement('span');
  handleSpan.className = 'handle';
  handleSpan.textContent = `@${handle}`;
  authorInfo.appendChild(handleSpan);

  header.appendChild(authorInfo);

  // Time
  if (timeText) {
    const timeSpan = document.createElement('span');
    timeSpan.className = 'post-time';
    timeSpan.textContent = timeText;
    header.appendChild(timeSpan);
  }

  return header;
}

/**
 * Create a "View on Bluesky" link element.
 * @param {string} postUrl - URL to the post on Bluesky
 * @param {string} [text='View on Bluesky'] - Link text
 */
export function createBlueskyLink(postUrl, text = 'View on Bluesky') {
  const actions = document.createElement('div');
  actions.className = 'link-actions';

  const link = document.createElement('a');
  link.className = 'thread-link';
  link.href = postUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = text;
  actions.appendChild(link);

  return actions;
}

/**
 * Show a status message in a status element.
 * @param {HTMLElement} element - The status div
 * @param {string} message - Message text
 * @param {string} [type='info'] - Status type: 'info', 'loading', or 'error'
 */
export function showStatusMessage(element, message, type = 'info') {
  element.className = `status ${type}`;
  setText(element, message);
  element.style.display = 'block';
}

/**
 * Hide a status element.
 * @param {HTMLElement} element - The status div
 */
export function hideStatusMessage(element) {
  element.style.display = 'none';
}

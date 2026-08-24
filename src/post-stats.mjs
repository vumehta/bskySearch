// Engagement stat rendering shared by search results and quote cards.

const LIKE_ICON = '♥ ';
const REPOST_ICON = '↻ ';
const REPLY_ICON = '💬 ';

// Search results only style `.stat.likes`, so reposts and replies stay unmodified.
export const SEARCH_STAT_CLASSES = {
  likes: 'stat likes',
  reposts: 'stat',
  replies: 'stat',
};

export const QUOTE_STAT_CLASSES = {
  likes: 'quote-stat likes',
  reposts: 'quote-stat reposts',
  replies: 'quote-stat replies',
};

export function createStatElement(className, icon, count, noun) {
  const stat = document.createElement('span');
  stat.className = className;
  stat.setAttribute('aria-label', `${count} ${noun}`);

  const iconEl = document.createElement('span');
  iconEl.setAttribute('aria-hidden', 'true');
  iconEl.textContent = icon;
  stat.appendChild(iconEl);

  stat.appendChild(document.createTextNode(count));
  return stat;
}

export function appendEngagementStats(container, post, classNames) {
  container.appendChild(
    createStatElement(classNames.likes, LIKE_ICON, post.likeCount || 0, 'likes')
  );
  container.appendChild(
    createStatElement(classNames.reposts, REPOST_ICON, post.repostCount || 0, 'reposts')
  );
  container.appendChild(
    createStatElement(classNames.replies, REPLY_ICON, post.replyCount || 0, 'replies')
  );
}

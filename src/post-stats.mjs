const LIKE_ICON = '♥ ';
const REPOST_ICON = '↻ ';
const REPLY_ICON = '💬 ';
const SAVE_ICON = '🔖 ';

export const SEARCH_STAT_CLASSES = {
  likes: 'stat likes',
  reposts: 'stat',
  replies: 'stat',
  saves: 'stat',
};

export const QUOTE_STAT_CLASSES = {
  likes: 'quote-stat likes',
  reposts: 'quote-stat reposts',
  replies: 'quote-stat replies',
  saves: 'quote-stat',
};

function createStatElement(className, icon, count, noun) {
  const stat = document.createElement('span');
  stat.className = className;

  const iconEl = document.createElement('span');
  iconEl.setAttribute('aria-hidden', 'true');
  iconEl.textContent = icon;
  stat.appendChild(iconEl);

  stat.appendChild(document.createTextNode(count));

  const nounEl = document.createElement('span');
  nounEl.className = 'visually-hidden';
  nounEl.textContent = ` ${noun}`;
  stat.appendChild(nounEl);
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
  container.appendChild(
    createStatElement(classNames.saves, SAVE_ICON, post.bookmarkCount || 0, 'saves')
  );
}

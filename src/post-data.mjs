const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value) => value == null || typeof value === 'string';
const optionalCount = (value) => value == null || (Number.isFinite(value) && value >= 0);

function hasSafeImageFields(embed) {
  if (embed?.$type !== 'app.bsky.embed.images#view') return true;
  return Array.isArray(embed.images) && embed.images.every((image) =>
    isObject(image) && optionalString(image.thumb) && optionalString(image.alt));
}

// Validate the fields consumed by post cards before caching or committing data.
// Optional null values use the same fallbacks as the renderers.
export function isRenderablePost(post) {
  return isObject(post)
    && typeof post.uri === 'string'
    && /^at:\/\/[^/\s]+\/app\.bsky\.feed\.post\/[^/\s]+$/.test(post.uri)
    && isObject(post.author)
    && typeof post.author.handle === 'string'
    && /^[a-zA-Z0-9._-]+$/.test(post.author.handle)
    && optionalString(post.author.displayName)
    && optionalString(post.author.avatar)
    && optionalString(post.indexedAt)
    && hasSafeImageFields(post.embed)
    && (post.record == null || (isObject(post.record)
      && optionalString(post.record.createdAt)
      && optionalString(post.record.text)))
    && ['likeCount', 'repostCount', 'replyCount', 'quoteCount'].every((key) => optionalCount(post[key]));
}

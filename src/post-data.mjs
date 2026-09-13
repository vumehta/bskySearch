const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value) => value == null || typeof value === 'string';
const optionalObject = (value) => value == null || isObject(value);
const optionalCount = (value) => value == null || (Number.isFinite(value) && value >= 0);

function previewSource(embed) {
  switch (embed?.$type) {
    case 'app.bsky.embed.images#view': return { items: embed.images, thumbKey: 'thumb' };
    case 'app.bsky.embed.gallery#view': return { items: embed.items, thumbKey: 'thumbnail' };
    case 'app.bsky.embed.video#view': return { items: [embed], thumbKey: 'thumbnail', video: true };
    case 'app.bsky.embed.recordWithMedia#view': return previewSource(embed.media);
    default: return null;
  }
}

// Embeds without previews are not rendered, so they need no checks.
function hasSafeEmbedPreviews(embed) {
  const source = previewSource(embed);
  return !source || (Array.isArray(source.items) && source.items.every((item) =>
    isObject(item) && optionalString(item[source.thumbKey]) && optionalString(item.alt)));
}

// Previews of a validated embed as { kind: 'image' | 'video', images: [{ thumb, alt }] }, or null.
export function getEmbedPreviews(embed) {
  const source = previewSource(embed);
  return source && {
    kind: source.video ? 'video' : 'image',
    images: source.items.map((item) => ({ thumb: item[source.thumbKey], alt: item.alt })),
  };
}

// Validate the fields consumed by post cards before caching or committing data.
// Optional null values use the same fallbacks as the renderers.
export function isRenderablePost(post) {
  return isObject(post)
    && typeof post.uri === 'string'
    && /^at:\/\/[^/\s]+\/app\.bsky\.feed\.post\/[^/\s]+$/.test(post.uri)
    && isObject(post.author)
    && typeof post.author.did === 'string'
    && /^did:[a-z]+:[A-Za-z0-9._:%-]*[A-Za-z0-9._-]$/.test(post.author.did)
    && typeof post.author.handle === 'string'
    && /^[a-zA-Z0-9._-]+$/.test(post.author.handle)
    && optionalString(post.author.displayName)
    && optionalString(post.author.avatar)
    && optionalString(post.author.pronouns)
    && optionalObject(post.author.verification)
    && optionalObject(post.author.status)
    && optionalString(post.indexedAt)
    && hasSafeEmbedPreviews(post.embed)
    && (post.record == null || (isObject(post.record)
      && optionalString(post.record.createdAt)
      && optionalString(post.record.text)))
    && ['likeCount', 'repostCount', 'replyCount', 'quoteCount', 'bookmarkCount'].every((key) => optionalCount(post[key]));
}

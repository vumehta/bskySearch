// The evidence sent to the topic classifier, shared by the browser (which
// builds it from a post) and the API (which re-normalizes whatever arrives).
// Every field is written by strangers, so it is only ever used as classifier
// input or shown as plain text by the post card (see post-embeds.mjs), which
// reads embeds through the same helpers; nothing here is interpreted.

export const TOPIC_LIMITS = Object.freeze({
  maxItems: 25,
  maxKeywords: 6,
  id: 300,
  keyword: 80,
  postText: 1200,
  author: 160,
  title: 300,
  description: 500,
  site: 100,
  path: 200,
  imageDescription: 500,
  maxImageDescriptions: 4,
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Control characters and runs of whitespace carry no meaning for the classifier.
export function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
    // Do not leave half of a surrogate pair at the cut.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text;
}

// The keyword is quoted inside the classifier's instructions, so quote
// characters and backticks (the API's state-path syntax) are removed.
export function normalizeKeyword(value) {
  if (typeof value !== 'string') return '';
  return cleanText(value.replace(/["`\u{201C}\u{201D}]/gu, ' '), TOPIC_LIMITS.keyword);
}

function withoutEmpty(fields) {
  const kept = Object.entries(fields).filter(([, value]) =>
    Array.isArray(value) ? value.length > 0 : isObject(value) ? Object.keys(value).length > 0 : Boolean(value));
  return Object.fromEntries(kept);
}

function sanitizeLinkCard(raw) {
  if (!isObject(raw)) return {};
  return withoutEmpty({
    title: cleanText(raw.title, TOPIC_LIMITS.title),
    description: cleanText(raw.description, TOPIC_LIMITS.description),
    site: cleanText(raw.site, TOPIC_LIMITS.site),
    path: cleanText(raw.path, TOPIC_LIMITS.path),
  });
}

function sanitizeQuotedPost(raw) {
  if (!isObject(raw)) return {};
  return withoutEmpty({
    text: cleanText(raw.text, TOPIC_LIMITS.postText),
    author: cleanText(raw.author, TOPIC_LIMITS.author),
    link_title: cleanText(raw.link_title, TOPIC_LIMITS.title),
  });
}

// Returns a context with a fixed key order and only non-empty fields, or null
// when the input is not an object. Sanitizing a sanitized context is a no-op,
// which lets the API hash exactly what it forwards.
export function sanitizeTopicContext(raw) {
  if (!isObject(raw)) return null;
  const imageDescriptions = Array.isArray(raw.image_descriptions)
    ? raw.image_descriptions
      .map((alt) => cleanText(alt, TOPIC_LIMITS.imageDescription))
      .filter(Boolean)
      .slice(0, TOPIC_LIMITS.maxImageDescriptions)
    : [];
  return withoutEmpty({
    post_text: cleanText(raw.post_text, TOPIC_LIMITS.postText),
    author: cleanText(raw.author, TOPIC_LIMITS.author),
    link_card: sanitizeLinkCard(raw.link_card),
    image_descriptions: imageDescriptions,
    quoted_post: sanitizeQuotedPost(raw.quoted_post),
  });
}

// An author alone says nothing about the subject of a post.
export function hasTopicEvidence(context) {
  return isObject(context) && Object.keys(context).some((key) => key !== 'author');
}

function formatAuthor(author) {
  if (!isObject(author)) return '';
  const handle = typeof author.handle === 'string' && author.handle ? `@${author.handle}` : '';
  const name = typeof author.displayName === 'string' ? author.displayName.trim() : '';
  if (name && handle) return `${name} (${handle})`;
  return name || handle;
}

// A link's slug often names its subject when the card's title does not. The
// query and fragment are left out: tracking parameters such as
// `utm_source=Facebook` would read as a mention of Facebook.
function getLinkLocation(uri) {
  if (typeof uri !== 'string') return {};
  try {
    const url = new URL(uri);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return {};
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep the encoded form of a malformed path.
    }
    return { site: url.hostname.replace(/^www\./, ''), path: path === '/' ? '' : path };
  } catch {
    return {};
  }
}

// A quote with media keeps its link card or images one level down.
const getMedia = (embed) => (embed?.$type === 'app.bsky.embed.recordWithMedia#view' ? embed.media : embed);

// Raw fields of a link card. `uri` is for the post card, which validates it
// before linking; the classifier is only ever sent the site and the path.
export function getLinkCard(embed) {
  const media = getMedia(embed);
  const external = media?.$type === 'app.bsky.embed.external#view' ? media.external : null;
  if (!isObject(external)) return null;
  return { uri: external.uri, title: external.title, description: external.description, ...getLinkLocation(external.uri) };
}

function getImageDescriptions(embed) {
  switch (embed?.$type) {
    case 'app.bsky.embed.images#view':
      return Array.isArray(embed.images) ? embed.images.map((image) => image?.alt) : [];
    case 'app.bsky.embed.gallery#view':
      return Array.isArray(embed.items) ? embed.items.map((item) => item?.alt) : [];
    case 'app.bsky.embed.video#view':
      return [embed.alt];
    default:
      return [];
  }
}

// Only a resolved post view carries a `value`; blocked, deleted, and detached
// quotes, as well as feeds and lists, have nothing to read.
function getQuotedRecord(embed) {
  const view = embed?.$type === 'app.bsky.embed.recordWithMedia#view' ? embed.record?.record
    : embed?.$type === 'app.bsky.embed.record#view' ? embed.record
      : null;
  return isObject(view) && isObject(view.value) ? view : null;
}

// Raw fields of a resolved quote, all unvalidated, with its own link card.
export function getQuotedPost(embed) {
  const quoted = getQuotedRecord(embed);
  if (!quoted) return null;
  const embeds = Array.isArray(quoted.embeds) ? quoted.embeds : [];
  const linkCard = embeds.map((item) => getLinkCard(item)).find(Boolean) || null;
  return { uri: quoted.uri, author: quoted.author, text: quoted.value.text, linkCard };
}

// Reaction posts ("wow") keep their subject in a link card, an image, or the
// post they quote, so all of that is part of what the classifier judges.
export function buildTopicContext(post) {
  if (!isObject(post)) return null;
  const embed = isObject(post.embed) ? post.embed : null;
  const quoted = getQuotedPost(embed);
  return sanitizeTopicContext({
    post_text: post.record?.text,
    author: formatAuthor(post.author),
    link_card: getLinkCard(embed),
    image_descriptions: getImageDescriptions(getMedia(embed)),
    quoted_post: quoted && {
      text: quoted.text,
      author: formatAuthor(quoted.author),
      link_title: quoted.linkCard?.title,
    },
  });
}

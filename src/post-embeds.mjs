import { TOPIC_LIMITS, cleanText, getLinkCard, getQuotedPost } from './topic-context.mjs';
import { getHttpUrl, getPostUrlFromAtUri } from './utils.mjs';

// Embeds are not covered by isRenderablePost, so every field may have the wrong
// type. Descriptive text uses the classifier's cleanup and limits; hostnames
// and handles remain complete so their domain suffixes are visible. All content
// is only ever set as text.

const plainText = (text) => document.createTextNode(text);

function createElement(tagName, className, content) {
  const element = document.createElement(tagName);
  element.className = className;
  if (content) element.appendChild(content);
  return element;
}

function createExternalLink(className, href, content) {
  const link = createElement('a', className, content);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

// There is no thumbnail: like post images, nothing loads until the reader asks,
// and the CSP would refuse one served from outside Bluesky's CDN.
function createLinkCard(linkCard, renderText, { compact = false } = {}) {
  const href = getHttpUrl(linkCard.uri);
  const title = cleanText(linkCard.title, TOPIC_LIMITS.title);
  const description = compact ? '' : cleanText(linkCard.description, TOPIC_LIMITS.description);
  // Preserve the complete hostname from the linked URL. Classifier limits
  // would hide the actual destination domain at the end of a long hostname.
  const site = href ? new URL(href).hostname.replace(/^www\./, '') : '';
  const heading = title || site;
  if (!heading && !description) return null;

  const card = createElement('div', 'embed-link');
  if (heading) {
    const className = title ? 'embed-link-title' : 'embed-link-title embed-link-hostname';
    card.appendChild(href
      ? createExternalLink(className, href, renderText(heading))
      : createElement('span', className, renderText(heading)));
  }
  if (title && site) card.appendChild(createElement('div', 'embed-link-site', plainText(site)));
  if (description) card.appendChild(createElement('div', 'embed-link-description', renderText(description)));
  return card;
}

function createQuotedPost(quoted, renderText) {
  const handle = cleanText(quoted.author?.handle, Infinity);
  const name = cleanText(quoted.author?.displayName, TOPIC_LIMITS.author) || handle;
  const text = cleanText(quoted.text, TOPIC_LIMITS.postText);
  const linkCard = quoted.linkCard && createLinkCard(quoted.linkCard, renderText, { compact: true });
  if (!name && !text && !linkCard) return null;

  const quote = createElement('blockquote', 'embed-quote');
  const header = createElement('div', 'embed-quote-header');
  if (name) header.appendChild(createElement('span', 'embed-quote-name', plainText(name)));
  if (handle) header.appendChild(createElement('span', 'embed-quote-handle', plainText(`@${handle}`)));
  const postUrl = getPostUrlFromAtUri(quoted.uri);
  if (postUrl) header.appendChild(createExternalLink('thread-link embed-quote-link', postUrl, plainText('View quote \u2192')));
  if (header.children.length > 0) quote.appendChild(header);
  if (text) quote.appendChild(createElement('div', 'embed-quote-text', renderText(text)));
  if (linkCard) quote.appendChild(linkCard);
  return quote;
}

// Shows the link card and the quoted post, which the topic filter judges along
// with the text: they are what explains a kept post that only says "wow".
// `renderText` turns a string into a node, which lets search highlight terms.
export function appendPostEmbeds(container, embed, renderText = plainText) {
  const linkCard = getLinkCard(embed);
  const quoted = getQuotedPost(embed);
  [
    linkCard && createLinkCard(linkCard, renderText),
    quoted && createQuotedPost(quoted, renderText),
  ].filter(Boolean).forEach((element) => container.appendChild(element));
}

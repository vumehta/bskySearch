import { describe, expect, it } from 'vitest';
import { createHighlightMatcher, getPostContentFingerprint, getPostRenderFingerprint, ingestSearchPosts, nextSearchCursor, validateSearchPage } from '../src/search-model.mjs';
import { getEmbedPreviews, isRenderablePost } from '../src/post-data.mjs';

const renderablePost = () => ({
  uri: 'at://did:plc:test/app.bsky.feed.post/one',
  author: { did: 'did:plc:test', handle: 'alice.bsky.social' },
  record: { text: 'A post', createdAt: '2026-09-05T00:00:00Z' },
});

const previewEmbeds = () => ({
  images: { $type: 'app.bsky.embed.images#view', images: [{ thumb: 'https://cdn.bsky.app/image', alt: 'Description' }] },
  gallery: { $type: 'app.bsky.embed.gallery#view', items: [{ thumbnail: 'https://cdn.bsky.app/image', alt: 'Description' }] },
  video: { $type: 'app.bsky.embed.video#view', thumbnail: 'https://video.bsky.app/thumbnail.jpg', alt: 'Description' },
});
const quoteWithMedia = (media) => ({ $type: 'app.bsky.embed.recordWithMedia#view', record: {}, media });

describe('production search transformations', () => {
  it('merges overlapping pages and terms without mutating cached input posts', () => {
    const first = { uri: 'at://p1', likeCount: 1, matchedTerm: 'Apple' };
    const second = { uri: 'at://p1', likeCount: 5, matchedTerms: ['apple', 'pie'] };
    const map = new Map();
    ingestSearchPosts(map, [first]);
    ingestSearchPosts(map, [second, { uri: 'at://p2', matchedTerm: 'pie' }]);
    expect(map.size).toBe(2);
    expect(map.get('at://p1')).toMatchObject({ likeCount: 5, matchedTerms: ['Apple', 'pie'], matchedTerm: 'Apple' });
    expect(first).toEqual({ uri: 'at://p1', likeCount: 1, matchedTerm: 'Apple' });
    expect(second.matchedTerms).toEqual(['apple', 'pie']);
  });

  it('highlights whole overlapping phrases and escapes literal regex punctuation', () => {
    const matcher = createHighlightMatcher(['apple', 'apple pie', 'c++', '[tag]']);
    const text = 'APPLE PIE with c++ and [tag]';
    expect(text.match(matcher.regex)).toEqual(['APPLE PIE', 'c++', '[tag]']);
    expect(matcher.termSet.has('apple pie')).toBe(true);
    expect(createHighlightMatcher([]).regex).toBe(null);
  });

  it('rejects terminal, repeated, cyclic and non-string pagination cursors', () => {
    const seen = new Set(['a', 'b']);
    expect(nextSearchCursor(undefined, 'b', seen)).toBe(null);
    expect(nextSearchCursor('b', 'b', seen)).toBe(null);
    expect(nextSearchCursor('a', 'b', seen)).toBe(null);
    expect(nextSearchCursor(42, 'b', seen)).toBe(null);
    expect(nextSearchCursor('c', 'b', seen)).toBe('c');
  });

  it('keeps render fingerprints distinct when field values contain separators', () => {
    const a = { author: { displayName: 'Alice\u0002Bob', avatar: 'image' } };
    const b = { author: { displayName: 'Alice', avatar: 'Bob\u0002image' } };
    expect(getPostRenderFingerprint(a)).not.toBe(getPostRenderFingerprint(b));
    expect(getPostRenderFingerprint({ matchedTerms: ['a\u0001b'] }))
      .not.toBe(getPostRenderFingerprint({ matchedTerms: ['a', 'b'] }));
  });

  it.each(['author.displayName', 'author.avatar', 'author.pronouns', 'indexedAt', 'record.createdAt', 'record.text', 'likeCount', 'repostCount', 'replyCount', 'quoteCount', 'bookmarkCount'])
  ('rejects a malformed rendered %s field before accepting a page', (path) => {
    const post = renderablePost();
    const parts = path.split('.');
    const object = parts.length === 2 ? post[parts[0]] : post;
    object[parts.at(-1)] = { toString: 1, valueOf: 1 };
    expect(isRenderablePost(post)).toBe(false);
    expect(() => validateSearchPage({ posts: [post] })).toThrow('invalid search response');
  });

  it('accepts absent and null optional card fields with renderer fallbacks', () => {
    const post = renderablePost();
    post.author.displayName = null;
    post.author.avatar = null;
    post.author.pronouns = null;
    post.author.verification = null;
    post.author.status = null;
    post.indexedAt = null;
    post.record.createdAt = null;
    post.record.text = null;
    for (const key of ['likeCount', 'repostCount', 'replyCount', 'quoteCount', 'bookmarkCount']) post[key] = null;
    expect(isRenderablePost(post)).toBe(true);
    expect(validateSearchPage({ posts: [post] }).posts).toEqual([post]);
    expect(isRenderablePost({ ...post, record: null })).toBe(true);
    expect(isRenderablePost({ ...post, record: undefined })).toBe(true);
  });

  it('rejects function-valued card fields and non-finite numeric counts', () => {
    const post = renderablePost();
    expect(isRenderablePost({ ...post, author: { ...post.author, displayName: () => 'Alice' } })).toBe(false);
    expect(isRenderablePost({ ...post, likeCount: Infinity })).toBe(false);
    expect(isRenderablePost({ ...post, replyCount: '2' })).toBe(false);
  });

  it('rejects author verification and status that are not objects', () => {
    const post = renderablePost();
    expect(isRenderablePost({ ...post, author: { ...post.author, verification: 'valid' } })).toBe(false);
    expect(isRenderablePost({ ...post, author: { ...post.author, status: 'app.bsky.actor.status#live' } })).toBe(false);
  });

  it('keeps saves and author badge fields out of the content fingerprint', () => {
    const base = renderablePost();
    for (const changed of [
      { ...base, bookmarkCount: 1 },
      { ...base, author: { ...base.author, pronouns: 'she/her' } },
      { ...base, author: { ...base.author, verification: { verifiedStatus: 'valid' } } },
      { ...base, author: { ...base.author, status: { status: 'app.bsky.actor.status#live' } } },
    ]) {
      expect(getPostRenderFingerprint(changed)).not.toBe(getPostRenderFingerprint(base));
      expect(getPostContentFingerprint(changed)).toBe(getPostContentFingerprint(base));
    }
    const moved = { ...base, author: { ...base.author, did: 'did:plc:other' } };
    expect(getPostContentFingerprint(moved)).not.toBe(getPostContentFingerprint(base));
  });

  it.each([undefined, null, 'plc:test', 'did:plc:', 'did:PLC:test', 'did:plc:te st'])
  ('rejects a malformed author DID: %s', (did) => {
    const post = renderablePost();
    post.author.did = did;
    expect(isRenderablePost(post)).toBe(false);
  });

  it.each([
    ['images', (embed) => embed.images[0], 'thumb'],
    ['gallery', (embed) => embed.items[0], 'thumbnail'],
    ['video', (embed) => embed, 'thumbnail'],
  ])('rejects malformed %s preview fields', (type, preview, thumbKey) => {
    const post = renderablePost();
    post.embed = previewEmbeds()[type];
    expect(isRenderablePost(post)).toBe(true);
    preview(post.embed).alt = { toString: 1, valueOf: 1 };
    expect(isRenderablePost(post)).toBe(false);
    preview(post.embed).alt = 'Description';
    preview(post.embed)[thumbKey] = {};
    expect(isRenderablePost(post)).toBe(false);
  });

  it('validates the media of a quote post the same way', () => {
    const post = renderablePost();
    post.embed = quoteWithMedia(previewEmbeds().gallery);
    expect(isRenderablePost(post)).toBe(true);
    post.embed.media.items[0].thumbnail = {};
    expect(isRenderablePost(post)).toBe(false);
  });

  it('extracts preview thumbnails from image, gallery, video and quote-post embeds', () => {
    const { images, gallery, video } = previewEmbeds();
    const image = { kind: 'image', images: [{ thumb: 'https://cdn.bsky.app/image', alt: 'Description' }] };
    const clip = { kind: 'video', images: [{ thumb: 'https://video.bsky.app/thumbnail.jpg', alt: 'Description' }] };
    expect(getEmbedPreviews(images)).toEqual(image);
    expect(getEmbedPreviews(gallery)).toEqual(image);
    expect(getEmbedPreviews(video)).toEqual(clip);
    expect(getEmbedPreviews(quoteWithMedia(gallery))).toEqual(image);
    expect(getEmbedPreviews(quoteWithMedia(video))).toEqual(clip);
    const external = { $type: 'app.bsky.embed.external#view', external: { thumb: 'https://cdn.bsky.app/link' } };
    expect(getEmbedPreviews(external)).toBe(null);
    expect(getEmbedPreviews(quoteWithMedia(external))).toBe(null);
    expect(getEmbedPreviews(undefined)).toBe(null);
  });
});

import { describe, expect, it } from 'vitest';
import { createHighlightMatcher, getPostRenderFingerprint, ingestSearchPosts, nextSearchCursor, validateSearchPage } from '../src/search-model.mjs';
import { isRenderablePost } from '../src/post-data.mjs';

const renderablePost = () => ({
  uri: 'at://did:plc:test/app.bsky.feed.post/one',
  author: { handle: 'alice.bsky.social' },
  record: { text: 'A post', createdAt: '2026-09-05T00:00:00Z' },
});

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

  it.each(['author.displayName', 'author.avatar', 'indexedAt', 'record.createdAt', 'record.text', 'likeCount', 'repostCount', 'replyCount', 'quoteCount'])
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
    post.indexedAt = null;
    post.record.createdAt = null;
    post.record.text = null;
    for (const key of ['likeCount', 'repostCount', 'replyCount', 'quoteCount']) post[key] = null;
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

  it('rejects malformed image fields before the reveal button can coerce them', () => {
    const post = renderablePost();
    post.embed = { $type: 'app.bsky.embed.images#view', images: [{ thumb: 'https://cdn.bsky.app/image', alt: 'Description' }] };
    expect(isRenderablePost(post)).toBe(true);
    post.embed.images[0].alt = { toString: 1, valueOf: 1 };
    expect(isRenderablePost(post)).toBe(false);
    post.embed.images[0] = { thumb: {} };
    expect(isRenderablePost(post)).toBe(false);
  });
});

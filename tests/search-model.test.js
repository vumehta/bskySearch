import { describe, expect, it } from 'vitest';
import { createHighlightMatcher, ingestSearchPosts, validateSearchPage } from '../src/search-model.mjs';
import { isRenderablePost } from '../src/post-data.mjs';

const renderablePost = () => ({
  uri: 'at://did:plc:test/app.bsky.feed.post/one',
  author: { did: 'did:plc:test', handle: 'alice.bsky.social' },
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
});

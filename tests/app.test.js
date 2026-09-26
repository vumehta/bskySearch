import { describe, it, expect } from 'vitest';

import { sortPosts } from '../src/utils.mjs';

describe('sortPosts', () => {
  const posts = Object.freeze([
    { uri: 'at://4', indexedAt: '2023-12-31T00:00:00Z' },
    { uri: 'at://1', likeCount: 10, record: { createdAt: '2024-01-03T00:00:00Z' } },
    { uri: 'at://2', likeCount: 50, record: { createdAt: '2024-01-01T00:00:00Z' } },
    { uri: 'at://3', likeCount: 25, record: { createdAt: '2024-01-02T00:00:00Z' } },
  ]);

  it('defaults to descending likes, treating missing counts as zero, without changing the input', () => {
    const expected = [posts[2], posts[3], posts[1], posts[0]];
    expect(sortPosts(posts, 'top')).toEqual(expected);
    expect(sortPosts(posts)).toEqual(expected);
  });

  it('sorts by newest time without changing the input', () => {
    expect(sortPosts(posts, 'latest')).toEqual([posts[1], posts[3], posts[2], posts[0]]);
  });

  it('sorts by saves, breaking ties by likes, without changing the input', () => {
    const saved = [
      { uri: 'at://a', likeCount: 5, bookmarkCount: 2 },
      { uri: 'at://b', likeCount: 50 },
      { uri: 'at://c', likeCount: 9, bookmarkCount: 2 },
    ];
    expect(sortPosts(saved, 'bookmarks').map((post) => post.uri)).toEqual(['at://c', 'at://a', 'at://b']);
    expect(saved.map((post) => post.uri)).toEqual(['at://a', 'at://b', 'at://c']);
  });
});

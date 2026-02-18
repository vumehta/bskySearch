import { describe, expect, it } from 'vitest';

import { parseUrlState } from '../../src/frontend/utils';

describe('parseUrlState URL compatibility', () => {
  it('uses legacy sort for search mode when explicit searchSort is absent', () => {
    const parsed = parseUrlState('?terms=alpha&sort=latest');

    expect(parsed.terms).toBe('alpha');
    expect(parsed.searchSort).toBe('latest');
    expect(parsed.quoteSort).toBe('likes');
  });

  it('uses legacy sort for quote mode when explicit quoteSort is absent', () => {
    const parsed = parseUrlState('?post=https://bsky.app/profile/a/post/1&sort=recent');

    expect(parsed.searchSort).toBe('top');
    expect(parsed.quoteSort).toBe('recent');
  });

  it('prefers explicit params over legacy sort and falls back for invalid values', () => {
    const parsed = parseUrlState(
      '?sort=latest&searchSort=top&quoteSort=oldest&time=999&expand=1&minLikes=7',
    );

    expect(parsed.searchSort).toBe('top');
    expect(parsed.quoteSort).toBe('oldest');
    expect(parsed.time).toBe('24');
    expect(parsed.expand).toBe(true);
    expect(parsed.minLikes).toBe('7');
  });
});

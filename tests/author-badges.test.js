import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDocument, TestNode } from './helpers/dom.mjs';
import { appendAuthorBadges, isLive } from '../src/author-badges.mjs';

const live = (overrides = {}) => ({ status: 'app.bsky.actor.status#live', record: {}, ...overrides });

function render(author) {
  const container = new TestNode();
  appendAuthorBadges(container, author);
  return container.children.map((node) => [node.className, node.textContent]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
  vi.stubGlobal('document', createTestDocument([]).document);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('author badges', () => {
  it.each([
    ['a verified account', { verifiedStatus: 'valid', trustedVerifierStatus: 'none' }, 'Verified'],
    ['a trusted verifier', { verifiedStatus: 'none', trustedVerifierStatus: 'valid' }, 'Verifier'],
    ['a verified former verifier', { verifiedStatus: 'valid', trustedVerifierStatus: 'invalid' }, 'Verifier'],
  ])('labels %s like the official app', (_kind, verification, text) => {
    expect(render({ verification })).toEqual([[`badge ${text.toLowerCase()}`, text]]);
  });

  it.each([
    ['no verification data', undefined],
    ['a lapsed verification', { verifiedStatus: 'invalid', trustedVerifierStatus: 'none' }],
    ['an unverified account', { verifiedStatus: 'none', trustedVerifierStatus: 'none' }],
  ])('shows no badge for %s', (_kind, verification) => {
    expect(render({ verification })).toEqual([]);
  });

  it('shows LIVE only for an active, enabled live status', () => {
    expect(render({ status: live() })).toEqual([['badge live', 'LIVE']]);
    expect(isLive(live({ expiresAt: '2026-09-13T13:00:00Z', isActive: true }))).toBe(true);
    expect(isLive(live({ expiresAt: '2026-09-13T11:00:00Z', isActive: true }))).toBe(false);
    expect(isLive(live({ isActive: false }))).toBe(false);
    expect(isLive(live({ isDisabled: true }))).toBe(false);
    expect(isLive({ status: 'app.bsky.actor.status#away', record: {} })).toBe(false);
    expect(isLive(undefined)).toBe(false);
  });

  it('lists pronouns before the badges', () => {
    const author = {
      pronouns: 'she/her',
      verification: { verifiedStatus: 'valid', trustedVerifierStatus: 'none' },
      status: live(),
    };
    expect(render(author)).toEqual([['pronouns', 'she/her'], ['badge verified', 'Verified'], ['badge live', 'LIVE']]);
  });
});

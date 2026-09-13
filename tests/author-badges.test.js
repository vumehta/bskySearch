import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDocument, TestNode } from './helpers/dom.mjs';
import { appendAuthorBadges } from '../src/author-badges.mjs';

const live = (overrides = {}) => ({ status: 'app.bsky.actor.status#live', expiresAt: '2026-09-13T13:00:00Z', ...overrides });

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

  it('shows LIVE for a live status that expires in the future', () => {
    expect(render({ status: live() })).toEqual([['badge live', 'LIVE']]);
  });

  it.each([
    ['no expiry', live({ expiresAt: undefined })],
    ['an expired status', live({ expiresAt: '2026-09-13T11:00:00Z' })],
    ['a malformed expiry', live({ expiresAt: 'soon' })],
    ['an inactive status', live({ isActive: false })],
    ['a disabled status', live({ isDisabled: true })],
    ['another status kind', live({ status: 'app.bsky.actor.status#away' })],
  ])('shows no LIVE badge for %s', (_kind, status) => {
    expect(render({ status })).toEqual([]);
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

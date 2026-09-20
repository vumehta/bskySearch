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
  ])('shows no badge for %s', (_kind, verification) => {
    expect(render({ verification })).toEqual([]);
  });

  it('shows LIVE until the status expires', () => {
    const container = new TestNode();
    appendAuthorBadges(container, { status: live() });
    expect(container.children.map((node) => node.textContent)).toEqual(['LIVE']);
    vi.advanceTimersByTime(60 * 60 * 1000 - 1);
    expect(container.children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(container.children).toHaveLength(0);
  });

  it.each([
    ['no expiry', live({ expiresAt: undefined })],
    ['an expired status', live({ expiresAt: '2026-09-13T11:00:00Z' })],
    ['an inactive status', live({ isActive: false })],
    ['a disabled status', live({ isDisabled: true })],
    ['another status kind', live({ status: 'app.bsky.actor.status#away' })],
  ])('shows no LIVE badge for %s', (_kind, status) => {
    expect(render({ status })).toEqual([]);
  });
});

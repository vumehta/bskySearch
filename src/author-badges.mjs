const LIVE_STATUS = 'app.bsky.actor.status#live';

// Mirrors the official app: a valid status of either kind earns a badge, and a
// verifier keeps the verifier style even after its own status lapses ('invalid').
function getVerificationBadge(verification) {
  if (verification?.verifiedStatus !== 'valid' && verification?.trustedVerifierStatus !== 'valid') return null;
  return ['valid', 'invalid'].includes(verification.trustedVerifierStatus)
    ? { className: 'verifier', text: 'Verifier', title: 'Trusted verifier' }
    : { className: 'verified', text: 'Verified', title: 'Verified account' };
}

// As in the official app, a live status without a future expiry is not shown.
function isLive(status) {
  return status?.status === LIVE_STATUS
    && !status.isDisabled
    && status.isActive !== false
    && Date.parse(status.expiresAt) > Date.now();
}

function createBadge({ className, text, title }) {
  const badge = document.createElement('span');
  badge.className = `badge ${className}`;
  badge.title = title;
  badge.textContent = text;
  return badge;
}

// Cards are not rebuilt when a status lapses, so the badge removes itself.
// Browsers run longer timeouts immediately, hence the clamp and reschedule.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const expiryTimers = new WeakMap();
function removeAtExpiry(badge, expiresAt) {
  const remaining = Date.parse(expiresAt) - Date.now();
  if (remaining <= 0) {
    badge.remove();
    return;
  }
  expiryTimers.set(badge, setTimeout(() => removeAtExpiry(badge, expiresAt), Math.min(remaining, MAX_TIMEOUT_MS)));
}

// Call before removing a card or subtree so timers cannot retain detached DOM.
export function disposeAuthorBadges(container) {
  for (const badge of container.querySelectorAll('.live')) clearTimeout(expiryTimers.get(badge));
}

export function updateAuthorBadges(container, author) {
  disposeAuthorBadges(container);
  for (const selector of ['.pronouns', '.badge']) {
    for (const node of container.querySelectorAll(selector)) node.remove();
  }
  appendAuthorBadges(container, author);
}

export function appendAuthorBadges(container, author) {
  if (author.pronouns) {
    const pronouns = document.createElement('span');
    pronouns.className = 'pronouns';
    pronouns.textContent = author.pronouns;
    container.appendChild(pronouns);
  }
  const verification = getVerificationBadge(author.verification);
  if (verification) container.appendChild(createBadge(verification));
  if (isLive(author.status)) {
    const badge = createBadge({ className: 'live', text: 'LIVE', title: 'Live now' });
    container.appendChild(badge);
    removeAtExpiry(badge, author.status.expiresAt);
  }
}

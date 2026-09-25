const LIVE_STATUS = 'app.bsky.actor.status#live';

function getVerificationBadge(verification) {
  if (verification?.verifiedStatus !== 'valid' && verification?.trustedVerifierStatus !== 'valid') return null;
  return ['valid', 'invalid'].includes(verification.trustedVerifierStatus)
    ? { className: 'verifier', text: 'Verifier', title: 'Trusted verifier' }
    : { className: 'verified', text: 'Verified', title: 'Verified account' };
}

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

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const expiryTimers = new Map();

function removeAtExpiry(badge, expiresAt) {
  expiryTimers.set(badge, setTimeout(() => {
    expiryTimers.delete(badge);
    badge.remove();
  }, Math.min(Date.parse(expiresAt) - Date.now(), MAX_TIMEOUT_MS)));
}

export function clearBadgeTimers(element) {
  for (const [badge, timer] of expiryTimers) {
    if (!element.contains(badge)) continue;
    clearTimeout(timer);
    expiryTimers.delete(badge);
  }
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
    removeAtExpiry(badge, author.status.expiresAt);
    container.appendChild(badge);
  }
}

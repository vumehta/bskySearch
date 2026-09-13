const LIVE_STATUS = 'app.bsky.actor.status#live';

// Mirrors the official app: either valid status earns a badge, and an account
// with any trusted-verifier record shows the verifier badge instead.
function getVerificationBadge(verification) {
  if (verification?.verifiedStatus !== 'valid' && verification?.trustedVerifierStatus !== 'valid') return null;
  return ['valid', 'invalid'].includes(verification.trustedVerifierStatus)
    ? { className: 'verifier', text: 'Verifier', title: 'Trusted verifier' }
    : { className: 'verified', text: 'Verified', title: 'Verified account' };
}

export function isLive(status) {
  return status?.status === LIVE_STATUS
    && !status.isDisabled
    && status.isActive !== false
    && (!status.expiresAt || Date.parse(status.expiresAt) > Date.now());
}

function createBadge({ className, text, title }) {
  const badge = document.createElement('span');
  badge.className = `badge ${className}`;
  badge.title = title;
  badge.textContent = text;
  return badge;
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
    container.appendChild(createBadge({ className: 'live', text: 'LIVE', title: 'Live now' }));
  }
}

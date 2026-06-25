// Full CSI sequence range per ECMA-48: parameter/intermediate bytes (0x20-0x3f) + final byte (0x40-0x7e)
// Covers standard, private-mode (\x1b[?25h), and extended sequences
const CSI_REGEX = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;
// OSC sequences: \x1b] ... (terminated by BEL \x07 or ST \x1b\\)
// Covers hyperlinks (\x1b]8;;url\x1b\\), window titles (\x1b]0;title\x07), etc.
const OSC_REGEX = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// DCS sequences: \x1bP ... ST
const DCS_REGEX = /\x1bP[\s\S]*?(?:\x07|\x1b\\)/g;
// APC, SOS, PM sequences: \x1b[_X^] ... ST
const OTHER_ESC_REGEX = /\x1b[_X^][\s\S]*?(?:\x07|\x1b\\)/g;

export function stripAnsi(text) {
  return text
    .replace(OSC_REGEX, '')
    .replace(DCS_REGEX, '')
    .replace(OTHER_ESC_REGEX, '')
    .replace(CSI_REGEX, '');
}

// Claude Code renders rate limits across multiple lines in its TUI, e.g.:
//   "⚠ You've hit your limit"
//   "· resets 3pm (UTC)"
// Detection: find a "limit" line and a "resets" line within 6 lines of each other.

const LIMIT_PATTERNS = [
  /(?:hit|exceeded|reached).*(?:your|the)\s*(?:\d+-hour\s+)?limit/i,  // "hit/exceeded/reached your limit"
  /\d+-hour limit/i,                                // "5-hour limit"
  /limit reached/i,                                  // "limit reached"
  /usage limit/i,                                    // "usage limit"
  /out of.*usage/i,                                  // "out of extra usage"
  /rate limit/i,                                     // "rate limit"
  /try again in/i,                                   // "try again in X hours" (implies rate limiting)
];

const RESET_PATTERNS = [
  /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,   // "resets 3pm" / "resets at 3:00 PM"
  /resets?\s+in[:\s]\s*\d/i,                                   // "resets in: 3 hours"
  /try again in \d+\s*(?:hours?|minutes?|h|m)/i,               // "try again in 5 hours"
];

const WINDOW = 6;

function hasNearbyMatch(lines, idx, patterns) {
  const start = Math.max(0, idx - WINDOW);
  const end = Math.min(lines.length, idx + WINDOW + 1);
  for (let j = start; j < end; j++) {
    if (patterns.some(p => p.test(lines[j]))) return true;
  }
  return false;
}

export function isRateLimited(text, customPatterns = []) {
  const lines = stripAnsi(text).split('\n');

  // Custom patterns: check full text (user controls their own regex)
  if (customPatterns.length > 0) {
    const full = lines.join('\n');
    const custom = customPatterns.map(p => typeof p === 'string' ? new RegExp(p, 'i') : p);
    if (custom.some(p => p.test(full))) return true;
  }

  // Find a "limit" line with a "resets" line nearby (works for both
  // single-line messages and multi-line TUI renders)
  for (let i = 0; i < lines.length; i++) {
    if (LIMIT_PATTERNS.some(p => p.test(lines[i]))) {
      if (hasNearbyMatch(lines, i, RESET_PATTERNS)) return true;
    }
  }

  return false;
}

// Classify a real API-error message (already confirmed via the transcript's
// isApiErrorMessage flag) into retryable vs not. Retrying a 400 or a quota
// error is pointless and risky; only transient server/network faults qualify.
//
// Strategy is layered from most authoritative to most heuristic, so unseen
// errors are still classified sensibly:
//   1. Explicit machine-readable verdict in the payload ("retryable":true)
//   2. Hard non-retryable signals (quota / auth / bad request)
//   3. Server "try again later" wording — transient even on a 4xx status
//   4. HTTP status code family (4xx client → no; 5xx server → yes)
//   5. Keyword fallback for transport/network faults with no status code

// Errors whose retryability is decided regardless of status code.
const FORCE_NON_RETRYABLE = [
  /额度.*用尽|用尽.*额度|额度/,                          // quota exhausted (zh)
  /\b(quota|insufficient_quota|insufficient|credit)\b/i,
  /\b(invalid|unauthorized|forbidden|authentication|permission)\b/i,
  /参数错误|invalid[\s_-]?request|bad[\s_-]?request/i,
  /context.*(too long|length|exceed)|too many tokens|max.*tokens/i,
];
// Explicit "this is temporary, retry later" wording from the server. These
// are transient even when carried on a 4xx status (e.g. gateway 424 "no
// account is available, please try again later" from a pooled proxy).
const TRANSIENT_WORDING = [
  /try again later|please (?:try again|retry)|retry later/i,
  /no account.*available|no.*(?:capacity|slot).*available/i,
  /temporarily|temporary|please wait|稍后(?:重试|再试)|请稍[后候]/i,
];
// Transport/network faults that carry no HTTP status but are transient.
const NETWORK_RETRYABLE = [
  /socket|terminated|stream|aborted|reset by peer/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN/i,
  /\b(timeout|timed out|time-out)\b/i,
  /\b(overloaded|unavailable|gateway|temporarily|try again)\b/i,
  /cloudflare|origin_(response|gateway)|5xx/i,
];

export function classifyApiError(text, retryablePatterns = []) {
  if (!text) return 'unknown';
  const t = stripAnsi(text);

  // Layer 0 — user-supplied "force retryable" patterns (highest priority after
  // an explicit machine-readable false). For gateways that rotate to another
  // pooled account on retry, errors like "用户额度不足/请充值后重试" ARE worth
  // retrying even though they look like quota errors. This is gateway-specific
  // behavior, so it is opt-in via config rather than a built-in default.
  if (/"retryable"\s*:\s*false/i.test(t)) return 'non-retryable';
  if (retryablePatterns.length > 0) {
    const pats = retryablePatterns.map(p => typeof p === 'string' ? new RegExp(p, 'i') : p);
    if (pats.some(p => p.test(t))) return 'retryable';
  }

  // Layer 1 — explicit verdict the gateway/API embedded in the payload.
  if (/"retryable"\s*:\s*true/i.test(t)) return 'retryable';

  // Layer 2 — hard non-retryable signals win over everything below, so a
  // quota/auth/bad-request error is never hammered even if other words match.
  if (FORCE_NON_RETRYABLE.some(p => p.test(t))) return 'non-retryable';

  // Layer 3 — server explicitly said it's temporary ("try again later").
  // This must precede the status-code check so a transient 4xx (e.g. a 424
  // "no account available" from a pooled gateway) is retried, not rejected.
  if (TRANSIENT_WORDING.some(p => p.test(t))) return 'retryable';

  // Layer 4 — HTTP status code family. Covers 500/502/503/504/520/524/529…
  // and any future 5xx without enumerating them. 4xx (except 408/429) is
  // client-side and not retried here (429 rate limits are handled elsewhere).
  const status = t.match(/API Error:\s*(\d{3})\b/i) || t.match(/"(?:status|error_code)"\s*:\s*(\d{3})\b/i);
  if (status) {
    const code = parseInt(status[1], 10);
    if (code === 408) return 'retryable';            // request timeout
    if (code >= 400 && code < 500) return 'non-retryable';
    if (code >= 500 && code < 600) return 'retryable';
  }

  // Layer 5 — keyword fallback for status-less transport errors.
  if (NETWORK_RETRYABLE.some(p => p.test(t))) return 'retryable';
  return 'unknown';
}

export function findRateLimitMessage(text, customPatterns = []) {
  const lines = stripAnsi(text).split('\n');

  // Return the "resets" line — that's what parseResetTime needs
  for (const line of lines) {
    if (RESET_PATTERNS.some(p => p.test(line))) return line.trim();
  }

  // Fallback: any "limit" line
  for (const line of lines) {
    if (LIMIT_PATTERNS.some(p => p.test(line))) return line.trim();
  }

  return null;
}

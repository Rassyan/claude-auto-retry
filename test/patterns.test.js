import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, isRateLimited, findRateLimitMessage, classifyApiError } from '../src/patterns.js';

describe('stripAnsi', () => {
  it('removes bold codes', () => {
    assert.equal(stripAnsi('\x1b[1mlimit\x1b[0m'), 'limit');
  });
  it('removes color codes', () => {
    assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  });
  it('removes cursor positioning', () => {
    assert.equal(stripAnsi('\x1b[2Jhello\x1b[H'), 'hello');
  });
  it('leaves plain text unchanged', () => {
    assert.equal(stripAnsi('plain text'), 'plain text');
  });
  it('handles mixed content', () => {
    assert.equal(
      stripAnsi('5-hour \x1b[1mlimit\x1b[0m reached - resets 3pm'),
      '5-hour limit reached - resets 3pm'
    );
  });
});

describe('isRateLimited', () => {
  it('detects "5-hour limit reached"', () => {
    assert.equal(isRateLimited('5-hour limit reached - resets 3pm'), true);
  });
  it('detects "usage limit" with reset', () => {
    assert.equal(isRateLimited('Claude usage limit reached. Resets at 2pm'), true);
  });
  it('detects "out of extra usage"', () => {
    assert.equal(isRateLimited("You're out of extra usage · resets 3pm"), true);
  });
  it('detects "try again in 5 hours"', () => {
    assert.equal(isRateLimited('Please try again in 5 hours'), true);
  });
  it('detects "rate limit resets"', () => {
    assert.equal(isRateLimited('Rate limit hit. Resets at 4pm'), true);
  });
  it('returns false for normal output', () => {
    assert.equal(isRateLimited('I can help you with that code'), false);
  });
  it('returns false for empty string', () => {
    assert.equal(isRateLimited(''), false);
  });
  it('detects rate limit with ANSI codes embedded', () => {
    assert.equal(isRateLimited('5-hour \x1b[1mlimit\x1b[0m reached - resets 3pm'), true);
  });
  it('matches custom patterns', () => {
    assert.equal(isRateLimited('custom error xyz', [/custom error/i]), true);
  });
  it('detects "You\'ve hit your limit" (real Claude Code message)', () => {
    assert.equal(isRateLimited("You've hit your limit · resets 3pm (Asia/Tbilisi)"), true);
  });
  it('detects "hit the limit resets"', () => {
    assert.equal(isRateLimited('You hit the limit. Resets at 5pm'), true);
  });
  it('detects "usage limit · resets in: 3 hours"', () => {
    assert.equal(isRateLimited('usage limit · resets in: 3 hours'), true);
  });
});

describe('stripAnsi (private-mode sequences)', () => {
  it('strips cursor hide sequence', () => {
    assert.equal(stripAnsi('\x1b[?25lhello\x1b[?25h'), 'hello');
  });
  it('strips bracketed paste mode', () => {
    assert.equal(stripAnsi('\x1b[?2004htext\x1b[?2004l'), 'text');
  });
});

describe('findRateLimitMessage', () => {
  it('returns the matching line from multiline input', () => {
    const text = 'Some output\n5-hour limit reached - resets 3pm (Europe/Dublin)\nMore output';
    assert.equal(findRateLimitMessage(text), '5-hour limit reached - resets 3pm (Europe/Dublin)');
  });
  it('returns null when no match', () => {
    assert.equal(findRateLimitMessage('normal output\nmore output'), null);
  });
  it('returns the resets line from multi-line TUI render', () => {
    const text = '⚠ You\'ve hit your limit\n· resets 3pm (UTC)';
    assert.equal(findRateLimitMessage(text), '· resets 3pm (UTC)');
  });
  it('returns Resets line when limit and resets on different lines', () => {
    const text = '5-hour limit reached\nResets at 3pm (UTC)';
    assert.ok(findRateLimitMessage(text).includes('3pm'));
  });
});

describe('isRateLimited (multi-line TUI renders)', () => {
  it('detects limit + resets on separate lines', () => {
    assert.ok(isRateLimited('⚠ You\'ve hit your limit\n· resets 3pm (UTC)'));
  });
  it('detects box-drawing TUI format', () => {
    const text = '╭──────────╮\n│ ⚠ You\'ve hit your limit │\n│ · resets 3pm │\n╰──────────╯';
    assert.ok(isRateLimited(text));
  });
  it('detects 5-hour limit + Resets on separate lines', () => {
    assert.ok(isRateLimited('⚠ 5-hour limit reached\nResets at 3pm (UTC)'));
  });
  it('detects middle-dot separated multi-line', () => {
    assert.ok(isRateLimited('⚠ You\'ve hit your 5-hour limit\n· resets 3pm (Asia/Tbilisi)'));
  });
  it('rejects limit + resets too far apart (>6 lines)', () => {
    assert.equal(isRateLimited('hit your limit\n1\n2\n3\n4\n5\n6\n7\nresets 3pm'), false);
  });
  it('rejects normal output with no rate limit keywords', () => {
    assert.equal(isRateLimited('Working on your request\nHere is the code\nDone'), false);
  });
});

describe('stripAnsi (OSC sequences)', () => {
  it('strips OSC hyperlinks (\\x1b]8;;url\\x1b\\\\)', () => {
    const input = '\x1b]8;;https://example.com\x1b\\click here\x1b]8;;\x1b\\';
    assert.equal(stripAnsi(input), 'click here');
  });
  it('strips OSC window title (\\x1b]0;title\\x07)', () => {
    assert.equal(stripAnsi('\x1b]0;My Terminal\x07hello'), 'hello');
  });
  it('strips OSC + CSI mixed sequences', () => {
    const input = '\x1b]8;;url\x1b\\\x1b[33m5-hour limit reached - resets 3pm\x1b[0m\x1b]8;;\x1b\\';
    assert.equal(stripAnsi(input), '5-hour limit reached - resets 3pm');
  });
  it('rate limit detection works through OSC hyperlinks', () => {
    const input = '\x1b]8;;link\x1b\\5-hour limit reached\x1b]8;;\x1b\\ - resets 3pm';
    assert.ok(isRateLimited(input));
  });
});

describe('classifyApiError', () => {
  it('classifies 524 as retryable', () => {
    assert.equal(classifyApiError('API Error: 524 {"retryable":true}'), 'retryable');
  });
  it('classifies 504 gateway timeout as retryable', () => {
    assert.equal(classifyApiError('API Error: 504 {"error_name":"origin_gateway_timeout","status":504,"retryable":true}'), 'retryable');
  });
  it('classifies 502/503/520/529 as retryable via status family', () => {
    for (const code of [500, 502, 503, 520, 529]) {
      assert.equal(classifyApiError(`API Error: ${code} something broke`), 'retryable', `code ${code}`);
    }
  });
  it('honors explicit "retryable":true even with a 4xx-looking status', () => {
    // Authoritative payload verdict wins over status heuristics.
    assert.equal(classifyApiError('API Error: 409 {"retryable":true,"status":409}'), 'retryable');
  });
  it('honors explicit "retryable":false even on a 5xx', () => {
    assert.equal(classifyApiError('API Error: 500 {"retryable":false}'), 'non-retryable');
  });
  it('classifies 408 request timeout as retryable', () => {
    assert.equal(classifyApiError('API Error: 408 Request Timeout'), 'retryable');
  });
  it('classifies a transient 424 "no account available, try again later" as retryable', () => {
    // Real gateway error: 4xx status but the body says it is temporary.
    assert.equal(classifyApiError('API Error: 424 no account is available, please try again later (request id: 20260622)'), 'retryable');
  });
  it('classifies a 4xx with "try again later" wording as retryable', () => {
    assert.equal(classifyApiError('API Error: 429 server busy, please try again later'), 'retryable');
  });
  it('still rejects a 400 quota error even if it says try again', () => {
    // FORCE_NON_RETRYABLE (quota) must win over transient wording.
    assert.equal(classifyApiError('API Error: 400 本月额度已用尽, please try again later'), 'non-retryable');
  });
  it('classifies origin_response_timeout as retryable', () => {
    assert.equal(classifyApiError('origin_response_timeout cloudflare'), 'retryable');
  });
  it('classifies socket/terminated as retryable', () => {
    assert.equal(classifyApiError('API Error: The socket connection terminated'), 'retryable');
  });
  it('classifies overloaded as retryable', () => {
    assert.equal(classifyApiError('overloaded, please try again'), 'retryable');
  });
  it('classifies an unseen transient phrasing via keyword fallback', () => {
    assert.equal(classifyApiError('API Error: upstream temporarily unavailable, please try again'), 'retryable');
  });
  it('classifies 400 as non-retryable', () => {
    assert.equal(classifyApiError('API Error: 400 参数错误'), 'non-retryable');
  });
  it('classifies 401/403/404 as non-retryable via status family', () => {
    for (const code of [401, 403, 404]) {
      assert.equal(classifyApiError(`API Error: ${code} nope`), 'non-retryable', `code ${code}`);
    }
  });
  it('classifies quota exhausted as non-retryable', () => {
    assert.equal(classifyApiError('API Error: 400 本月额度已用尽'), 'non-retryable');
  });
  it('classifies context-length errors as non-retryable', () => {
    assert.equal(classifyApiError('API Error: prompt is too long, exceeds max tokens'), 'non-retryable');
  });
  it('quota/invalid wins even when transient words also present', () => {
    assert.equal(classifyApiError('API Error: 400 invalid request, connection timeout'), 'non-retryable');
  });
  it('returns unknown for unrelated text', () => {
    assert.equal(classifyApiError('Task completed successfully'), 'unknown');
  });
  it('returns unknown for empty', () => {
    assert.equal(classifyApiError(''), 'unknown');
  });
});

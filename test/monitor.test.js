import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, processOneTick } from '../src/monitor.js';
import { DEFAULT_CONFIG } from '../src/config.js';

function mockTmux(paneContent = '', paneCommand = 'node', claudeForeground = true, apiError = null) {
  const t = {
    _sent: [],
    capturePane: async () => paneContent,
    getPaneCommand: async () => paneCommand,
    sendKeys: async (_p, text) => { t._sent.push(text); },
    isClaudeForeground: async () => claudeForeground,
    getLastApiError: async () => apiError,
  };
  return t;
}

describe('processOneTick', () => {
  it('returns monitoring when no rate limit', async () => {
    const t = mockTmux('Normal output');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
  it('enters waiting on rate limit', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('exits when PID dead', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => false), 'exit');
  });
  it('sends retry when wait expired and rate limit visible', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(t._sent.length, 1);
    assert.equal(s.attempts, 1);
    // Should stay in 'waiting' with a cooldown to let Claude process
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('detects multi-line TUI rate limit', async () => {
    const t = mockTmux('⚠ You\'ve hit your limit\n· resets 3pm (UTC)');
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('retries when Claude process is in foreground (fixes macOS zsh issue)', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'zsh', true);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(t._sent.length, 1);
  });
  it('falls back to pane_current_command when process state is false', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'vim', false);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'skipped-not-claude');
    assert.equal(t._sent.length, 0);
    assert.equal(s._lastForeground, 'vim');
  });
  it('falls back to pane_current_command when process state is null', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'vim', null);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'skipped-not-claude');
    assert.equal(t._sent.length, 0);
    assert.equal(s._lastForeground, 'vim');
  });
  it('accepts custom foregroundCommands in fallback path', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'my-claude-wrapper', null);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    const config = { ...DEFAULT_CONFIG, foregroundCommands: ['my-claude-wrapper'] };
    assert.equal(await processOneTick(s, t, '%0', config, () => true), 'retried');
    assert.equal(t._sent.length, 1);
  });
  it('matches npx in fallback path', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'npx', null);
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
  });
  it('resets counter when rate limit disappears', async () => {
    const t = mockTmux('Claude is working normally');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 2;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.attempts, 0);
  });
  it('stops retrying after max attempts and stays in waiting', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 5;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'max-retries');
    // Should stay in 'waiting' to avoid re-detection loop
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now());
  });
  it('resets from max-retries when rate limit clears', async () => {
    const t = mockTmux('Claude is working normally');
    const s = createMonitorState();
    s.waitUntil = Date.now() - 1000; s.status = 'waiting'; s.attempts = 10;
    // Rate limit cleared → should detect user-continued before max-retries check
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.attempts, 0);
  });
  it('enters waiting on retryable API error from transcript', async () => {
    const t = mockTmux('Normal screen', 'node', true, { text: 'API Error: 524 origin_response_timeout' });
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(s.waitReason, 'transient');
    assert.ok(s.waitUntil > Date.now());
    assert.ok(s.waitUntil <= Date.now() + 10_000);
  });
  it('does NOT trigger on pasted 524 text (no isApiErrorMessage flag)', async () => {
    // Screen shows a 524 the user pasted, but transcript reports no API error.
    const t = mockTmux('API Error: 524 {"cloudflare_error":true}', 'node', true, null);
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
  it('does NOT retry non-retryable API errors (400 / quota)', async () => {
    const t = mockTmux('Normal screen', 'node', true, { text: 'API Error: 400 本月额度已用尽' });
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
  it('sends retry after transient wait expires, with 30s cooldown', async () => {
    const t = mockTmux('Normal screen', 'node', true, { text: 'API Error: 524 timeout' });
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() - 1; s.waitReason = 'transient';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(t._sent.length, 1);
    assert.equal(s.transientAttempts, 1);
    // Stays in waiting with cooldown so transcript can record the new turn
    assert.equal(s.status, 'waiting');
    assert.ok(s.waitUntil > Date.now() + 20_000);
  });
  it('user-continued resets transient state when error clears in transcript', async () => {
    const t = mockTmux('Normal screen', 'node', true, null);
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() - 1; s.waitReason = 'transient'; s.transientAttempts = 1;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s.transientAttempts, 0);
    assert.equal(s.waitReason, null);
    assert.equal(s.status, 'monitoring');
  });
  it('stops transient retries after maxTransientRetries', async () => {
    const t = mockTmux('Normal screen', 'node', true, { text: 'API Error: 524 timeout' });
    const s = createMonitorState();
    s.status = 'waiting'; s.waitUntil = Date.now() - 1; s.waitReason = 'transient';
    s.transientAttempts = DEFAULT_CONFIG.maxTransientRetries;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'max-retries');
    assert.equal(t._sent.length, 0);
    assert.equal(s.status, 'waiting');
  });
  it('rate limit takes priority over transient API error', async () => {
    const t = mockTmux('5-hour limit reached - resets 3pm (UTC)', 'node', true, { text: 'API Error: 524' });
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(s.waitReason, null);
    assert.ok(s.waitUntil > Date.now() + 60_000);
  });
  it('skips transient detection when maxTransientRetries is 0', async () => {
    const t = mockTmux('Normal screen', 'node', true, { text: 'API Error: 524 timeout' });
    const s = createMonitorState();
    const config = { ...DEFAULT_CONFIG, maxTransientRetries: 0 };
    assert.equal(await processOneTick(s, t, '%0', config, () => true), 'monitoring');
    assert.equal(t._sent.length, 0);
  });
});

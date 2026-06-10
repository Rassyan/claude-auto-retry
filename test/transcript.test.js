import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeCwd, entryText, findLastApiError, readLastApiError } from '../src/transcript.js';

describe('encodeCwd', () => {
  it('replaces slashes and dots with dashes', () => {
    assert.equal(encodeCwd('/Users/x/proj'), '-Users-x-proj');
    assert.equal(encodeCwd('/Users/x/.config'), '-Users-x--config');
  });
  it('replaces underscores with dashes (real Claude behavior)', () => {
    assert.equal(encodeCwd('/Users/x/elasticsearch_foo'), '-Users-x-elasticsearch-foo');
  });
  it('preserves existing dashes and alphanumerics', () => {
    assert.equal(encodeCwd('/Users/x/claude-auto-retry'), '-Users-x-claude-auto-retry');
  });
});

describe('entryText', () => {
  it('reads string content', () => {
    assert.equal(entryText({ message: { content: 'hello' } }), 'hello');
  });
  it('reads array content blocks', () => {
    assert.equal(entryText({ message: { content: [{ type: 'text', text: 'API Error: 524' }] } }), 'API Error: 524');
  });
  it('returns empty for missing content', () => {
    assert.equal(entryText({}), '');
  });
});

function line(obj) { return JSON.stringify(obj); }

describe('findLastApiError', () => {
  it('detects a real API error flagged by isApiErrorMessage', () => {
    const tail = [
      line({ type: 'assistant', message: { role: 'assistant', content: 'working' } }),
      line({ type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 524 origin_response_timeout' }] } }),
    ].join('\n');
    const r = findLastApiError(tail);
    assert.ok(r);
    assert.match(r.text, /524/);
  });
  it('returns null when a pasted 524 has NO isApiErrorMessage flag', () => {
    // The exact false-positive that broke screen-scraping: user pasted 524 text.
    const tail = [
      line({ type: 'user', message: { role: 'user', content: 'why did I get API Error: 524 cloudflare?' } }),
    ].join('\n');
    assert.equal(findLastApiError(tail), null);
  });
  it('returns null when a user turn follows the error (recovered)', () => {
    const tail = [
      line({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 524' }] } }),
      line({ type: 'user', message: { role: 'user', content: '继续' } }),
    ].join('\n');
    assert.equal(findLastApiError(tail), null);
  });
  it('skips trailing system entries to find the error', () => {
    const tail = [
      line({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } }),
      line({ type: 'system', content: 'post-error bookkeeping' }),
    ].join('\n');
    const r = findLastApiError(tail);
    assert.ok(r);
    assert.match(r.text, /529/);
  });
  it('skips file-history-snapshot between us and the error (real 504 case)', () => {
    // Exact structure from a real transcript: a snapshot entry follows the
    // API error. The old code stopped here and missed the error entirely.
    const tail = [
      line({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 504 origin_gateway_timeout' }] } }),
      line({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} }),
    ].join('\n');
    const r = findLastApiError(tail);
    assert.ok(r, 'should find the 504 behind the snapshot');
    assert.match(r.text, /504/);
  });
  it('treats a real user reply after the error as recovered', () => {
    const tail = [
      line({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 504' }] } }),
      line({ type: 'file-history-snapshot', snapshot: {} }),
      line({ type: 'user', message: { role: 'user', content: '继续' } }),
    ].join('\n');
    assert.equal(findLastApiError(tail), null);
  });
  it('returns null for normal assistant output', () => {
    const tail = line({ type: 'assistant', message: { content: 'Here is the answer' } });
    assert.equal(findLastApiError(tail), null);
  });
  it('ignores malformed JSON lines', () => {
    const tail = 'not json\n' + line({ type: 'assistant', message: { content: 'ok' } });
    assert.equal(findLastApiError(tail), null);
  });
});

// End-to-end through readTail + a real file on disk. This path was previously
// untested, which let a deleted readTail() helper ship silently (every call
// threw ReferenceError, caught and swallowed as null).
describe('readLastApiError (real file I/O)', () => {
  async function withTempFile(contentLines, fn) {
    const dir = await mkdtemp(join(tmpdir(), 'car-tx-'));
    const f = join(dir, 'session.jsonl');
    await writeFile(f, contentLines.join('\n') + '\n');
    try { return await fn(f); } finally { await rm(dir, { recursive: true, force: true }); }
  }

  it('reads a real 504 error from a file ending in bookkeeping', async () => {
    await withTempFile([
      line({ type: 'user', message: { content: 'do something' } }),
      line({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 504 origin_gateway_timeout retryable' }] } }),
      line({ type: 'file-history-snapshot', snapshot: {} }),
      line({ type: 'system', content: '' }),
    ], async (f) => {
      const r = await readLastApiError(f);
      assert.ok(r, 'should detect the 504 through real file I/O');
      assert.match(r.text, /504/);
    });
  });

  it('returns null for a recovered session on disk', async () => {
    await withTempFile([
      line({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 504' }] } }),
      line({ type: 'user', message: { content: '继续' } }),
    ], async (f) => {
      assert.equal(await readLastApiError(f), null);
    });
  });

  it('reads the error even when the tail is larger than one 64KB block', async () => {
    // A single huge line (like a big tool_result) precedes the error, forcing
    // the partial-first-line drop in readTail. The 504 must still be found.
    const huge = line({ type: 'assistant', message: { content: 'x'.repeat(70000) } });
    await withTempFile([
      huge,
      line({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 524 cloudflare' }] } }),
      line({ type: 'system', content: '' }),
    ], async (f) => {
      const r = await readLastApiError(f);
      assert.ok(r, 'should find 524 past a >64KB line');
      assert.match(r.text, /524/);
    });
  });

  it('returns null for a nonexistent file (no throw)', async () => {
    assert.equal(await readLastApiError('/no/such/transcript.jsonl'), null);
  });
});

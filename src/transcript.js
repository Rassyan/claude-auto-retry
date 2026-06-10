import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Claude Code encodes the working directory into a project-dir name by
// replacing every non-alphanumeric character with a dash. Verified against
// real dirs — note underscores are also converted:
//   /Users/x/.config            →  -Users-x--config
//   /Users/x/elasticsearch_foo  →  -Users-x-elasticsearch-foo
export function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// Locate the most-recently-written transcript (.jsonl) for a given cwd —
// that's the session currently being driven in this pane.
export async function findActiveTranscript(cwd, projectsDir = PROJECTS_DIR) {
  const dir = join(projectsDir, encodeCwd(cwd));
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  let newest = null, newestMtime = -1;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const s = await stat(join(dir, f));
      if (s.mtimeMs > newestMtime) { newestMtime = s.mtimeMs; newest = join(dir, f); }
    } catch { /* ignore unreadable entry */ }
  }
  return newest;
}

// Extract plain text from a transcript entry's message.content
// (content is either a string or an array of {type,text} blocks).
export function entryText(entry) {
  const c = entry?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(b => (typeof b === 'string' ? b : b?.text || '')).join(' ');
  }
  return '';
}

// Inspect the tail of a transcript: is the LAST meaningful entry a real
// API error (flagged by Claude Code with isApiErrorMessage:true)?
//
// Returns { text } when the session is currently sitting on an unrecovered
// API error, or null otherwise. Crucially, pasted/discussed "524" text is
// NOT flagged isApiErrorMessage, so it never matches — this is what makes
// detection immune to the false positives that plagued screen-scraping.
export function findLastApiError(tailText) {
  const lines = tailText.split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }

    // An API error is itself recorded as an assistant entry, so check the
    // flag FIRST — before any type-based skipping.
    if (entry.isApiErrorMessage === true) {
      return { text: entryText(entry) };
    }

    // Only real conversation turns (user / assistant text) decide whether the
    // session has moved past the error. Everything else — file-history-snapshot,
    // system, summary, and any future bookkeeping type — is skipped so we keep
    // scanning backward to the last meaningful turn. (This is the bug that hid
    // the 504: a file-history-snapshot sat between us and the error entry.)
    const type = entry.type;
    if (type !== 'user' && type !== 'assistant') continue;

    // An empty assistant/user record (e.g. tool-only) isn't a turn boundary.
    if (!entryText(entry).trim()) continue;

    // A genuine conversation turn (the user typed something, or the assistant
    // produced real output) after the error means the session recovered.
    return null;
  }
  return null;
}

export async function readLastApiError(path) {
  let tail;
  try { tail = await readTail(path); } catch { return null; }
  return findLastApiError(tail);
}

// Read only the tail of a (potentially huge) transcript file — these can grow
// to hundreds of MB, so we never load the whole thing. 256KB comfortably holds
// many entries even when a single line runs to tens of KB (large tool results
// have been observed at ~67KB). We drop the leading partial line so JSON.parse
// never sees a fragment.
async function readTail(path, maxBytes = 262144) {
  const s = await stat(path);
  const start = Math.max(0, s.size - maxBytes);
  const len = s.size - start;
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf-8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1); // drop partial first line
    }
    return text;
  } finally {
    await fh.close();
  }
}


import fs from 'node:fs';
import process from 'node:process';

function emit(s) {
  fs.writeSync(1, s);
}

function parseFail(line) {
  const e = new Error('parse ' + line);
  e.parseLine = line;
  return e;
}

// Patch lines: split at \n, one trailing \r removed, drop the empty
// piece after a final \n.
function splitPatchLines(text) {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  return parts;
}

function trimEndWs(s) {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s) {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s) {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function isSafePath(p) {
  if (p.length === 0) return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// A file's line model (section 3): line break is CRLF when the first
// line feed follows a carriage return, else LF.
function parseFile(text) {
  if (text === '') return { lines: [], eol: '\n', endBreak: false };
  const firstLf = text.indexOf('\n');
  const eol = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(eol);
  let endBreak = false;
  if (text.endsWith(eol)) {
    lines.pop();
    endBreak = true;
  }
  return { lines, eol, endBreak };
}

function serializeFile(f) {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.endBreak ? f.eol : '');
}

// A file an edit creates: LF breaks, ends with a line break when it
// has any lines.
function serializeCreated(lines) {
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
}

function cmpBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---- section 5: matching lines ----

function lineEq(a, b, tier) {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function findOccurrences(fileLines, oLines, tier) {
  const res = [];
  if (oLines.length === 0) return res;
  for (let i = 0; i + oLines.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oLines.length; j++) {
      if (!lineEq(fileLines[i + j], oLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

// First tier (0, then 1, then 2; strict: 0 only) with at least one
// occurrence satisfying `filter`; returns { tier, occs } or null.
function findTier(fileLines, oLines, strict, filter) {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const occs = findOccurrences(fileLines, oLines, tier).filter(filter);
    if (occs.length > 0) return { tier, occs };
  }
  return null;
}

// Build the replacement lines for a match at `pos`. nCtx[k] is the
// index into O of a context line of N, or -1 for a new line.
function buildN(fileLines, pos, oLines, nLines, nCtx, tier) {
  const out = [];
  const p = oLines.length > 0 ? leadingWs(oLines[0]) : '';
  const f = fileLines.length > pos ? leadingWs(fileLines[pos]) : '';
  for (let k = 0; k < nLines.length; k++) {
    if (nCtx[k] >= 0) {
      out.push(fileLines[pos + nCtx[k]]);
      continue;
    }
    const line = nLines[k];
    if (
      tier === 2 &&
      oLines.length > 0 &&
      line !== '' &&
      !/^[ \t]+$/.test(line) &&
      line.startsWith(p)
    ) {
      out.push(f + line.slice(p.length));
    } else {
      out.push(line);
    }
  }
  return out;
}

// ---- in-memory tree: edits apply here, disk is written only at the end ----

class Tree {
  constructor() {
    this.disk = new Map(); // path -> initial text, or undefined if absent
    this.cur = new Map(); // path -> current text
    this.origin = new Map(); // path -> initial path it came from, or null if created
    this.touched = new Set();
  }

  load(p) {
    if (this.disk.has(p)) return;
    this.touched.add(p);
    let content;
    try {
      content = fs.readFileSync(p, 'utf8');
    } catch {
      content = undefined;
    }
    this.disk.set(p, content);
    if (content !== undefined) {
      this.cur.set(p, content);
      this.origin.set(p, p);
    }
  }

  exists(p) {
    this.load(p);
    return this.cur.has(p);
  }

  get(p) {
    this.load(p);
    return this.cur.get(p);
  }

  set(p, content) {
    this.load(p);
    this.cur.set(p, content);
    if (!this.origin.has(p)) this.origin.set(p, null);
  }

  delete(p) {
    this.load(p);
    this.cur.delete(p);
    this.origin.delete(p);
  }

  move(oldP, newP, content) {
    this.load(oldP);
    this.load(newP);
    const o = this.origin.has(oldP) ? this.origin.get(oldP) : oldP;
    this.cur.delete(oldP);
    this.origin.delete(oldP);
    this.cur.set(newP, content);
    this.origin.set(newP, o);
  }
}

// ---- section 4: detecting the format ----

function detectFormat(lines) {
  let firstNonBlank;
  for (const l of lines) {
    if (l.trim() !== '') {
      firstNonBlank = l;
      break;
    }
  }
  if (firstNonBlank !== undefined && firstNonBlank.trim() === '*** Begin Patch') {
    return 'v4a';
  }
  if (firstNonBlank !== undefined) {
    const c = firstNonBlank.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (l.replace(/\s+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (
      lines[i].startsWith('--- ') &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith('+++ ')
    ) {
      return 'unified';
    }
  }
  return null;
}

// ---- section 2: output ----

function computeChanges(tree) {
  const changes = [];
  const suppressedD = new Set();
  const suppressedA = new Set();
  const rPairs = [];
  for (const [p, o] of tree.origin) {
    if (o === null || o === p) continue;
    if (!tree.cur.has(p)) continue;
    if (tree.disk.get(o) === undefined) continue;
    if (tree.disk.get(p) !== undefined) continue;
    if (tree.cur.has(o)) continue;
    rPairs.push({ oldPath: o, newPath: p });
    suppressedD.add(o);
    suppressedA.add(p);
  }
  for (const p of tree.touched) {
    const before = tree.disk.get(p);
    const after = tree.cur.has(p) ? tree.cur.get(p) : undefined;
    if (before === undefined && after === undefined) continue;
    if (before === undefined && after !== undefined) {
      if (!suppressedA.has(p)) changes.push({ kind: 'A', path: p });
      continue;
    }
    if (before !== undefined && after === undefined) {
      if (!suppressedD.has(p)) changes.push({ kind: 'D', path: p });
      continue;
    }
    if (before !== after) changes.push({ kind: 'M', path: p });
  }
  for (const r of rPairs) {
    changes.push({ kind: 'R', path: r.oldPath, newPath: r.newPath });
  }
  const sortKey = (c) => (c.kind === 'R' ? c.newPath : c.path);
  changes.sort((a, b) => cmpBytes(sortKey(a), sortKey(b)));
  return changes;
}

function writeChanges(tree) {
  for (const p of tree.touched) {
    const before = tree.disk.get(p);
    const after = tree.cur.has(p) ? tree.cur.get(p) : undefined;
    if (before !== undefined && after === undefined) fs.unlinkSync(p);
  }
  for (const p of tree.touched) {
    const before = tree.disk.get(p);
    const after = tree.cur.has(p) ? tree.cur.get(p) : undefined;
    if (after !== undefined && before !== after) {
      const slash = p.lastIndexOf('/');
      if (slash >= 0) fs.mkdirSync(p.slice(0, slash), { recursive: true });
      fs.writeFileSync(p, after, 'utf8');
    }
  }
}

// ---- section 1: invocation, and the main flow ----

function main() {
  const args = process.argv.slice(2);
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  let usageErr = false;
  const positional = [];
  for (const a of args) {
    if (!endOpts) {
      if (a === '--') {
        endOpts = true;
        continue;
      }
      if (a === '--check') {
        if (seenCheck) usageErr = true;
        seenCheck = true;
        check = true;
        continue;
      }
      if (a === '--strict') {
        if (seenStrict) usageErr = true;
        seenStrict = true;
        strict = true;
        continue;
      }
      if (a.startsWith('--format=')) {
        if (seenFormat) usageErr = true;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (
          v === 'unified' ||
          v === 'search-replace' ||
          v === 'v4a' ||
          v === 'json' ||
          v === 'auto'
        ) {
          format = v;
        } else {
          usageErr = true;
        }
        continue;
      }
      if (a.startsWith('-') && a !== '-') {
        usageErr = true;
        continue;
      }
      positional.push(a);
      continue;
    }
    positional.push(a);
  }
  if (positional.length > 1) usageErr = true;
  if (usageErr) {
    emit('error: usage\n');
    process.exit(2);
  }

  const patchArg = positional[0];
  let patchText;
  if (patchArg === undefined || patchArg === '-') {
    try {
      patchText = fs.readFileSync(0, 'utf8');
    } catch {
      patchText = '';
    }
  } else {
    try {
      patchText = fs.readFileSync(patchArg, 'utf8');
    } catch {
      emit('error: no-patch\n');
      process.exit(2);
    }
  }

  const lines = splitPatchLines(patchText);
  let fmt = format;
  if (fmt === 'auto') {
    fmt = detectFormat(lines);
    if (fmt === null) {
      emit('error: format\n');
      process.exit(2);
    }
  }

  let edits;
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(patchText, lines);
  } catch (e) {
    if (e && typeof e.parseLine === 'number') {
      emit('error: parse ' + e.parseLine + '\n');
      process.exit(2);
    }
    throw e;
  }

  const tree = new Tree();
  const failures = [];
  for (const edit of edits) {
    let res;
    if (fmt === 'unified') res = applyUnified(tree, edit, strict);
    else if (fmt === 'search-replace') res = applySearchReplace(tree, edit, strict);
    else if (fmt === 'v4a') res = applyV4a(tree, edit, strict);
    else res = applyJson(tree, edit);
    if (res) failures.push(res);
  }

  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += 'error: ' + f.code + ' ' + f.path + '\n';
    out += 'failed: ' + failures.length + ' of ' + edits.length + ' edits\n';
    emit(out);
    process.exit(1);
  }

  const changes = computeChanges(tree);
  if (!check) writeChanges(tree);
  let out = '';
  for (const c of changes) {
    if (c.kind === 'R') out += 'R ' + c.path + ' -> ' + c.newPath + '\n';
    else out += c.kind + ' ' + c.path + '\n';
  }
  out +=
    'ok: ' +
    changes.length +
    (changes.length === 1 ? ' file\n' : ' files\n');
  emit(out);
  process.exit(0);
}

// ---- section 6: unified diffs ----

function unifiedPath(raw) {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkBody(lines, start) {
  const body = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j];
    if (
      l.startsWith('--- ') &&
      j + 1 < lines.length &&
      lines[j + 1].startsWith('+++ ')
    ) {
      break;
    }
    if (
      l === '' ||
      l.startsWith(' ') ||
      l.startsWith('-') ||
      l.startsWith('+') ||
      l.startsWith('\\')
    ) {
      body.push(l);
      j++;
    } else {
      break;
    }
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const oLines = [];
  const nLines = [];
  const nCtx = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const b = body[k];
    if (b === '' || b.startsWith(' ')) {
      const t = b === '' ? '' : b.slice(1);
      oLines.push(t);
      nLines.push(t);
      nCtx.push(oLines.length - 1);
      lastCtxPlus = k;
    } else if (b.startsWith('-')) {
      oLines.push(b.slice(1));
    } else if (b.startsWith('+')) {
      nLines.push(b.slice(1));
      nCtx.push(-1);
      lastCtxPlus = k;
      lastPlus = k;
    }
  }
  const noNlCtxPlus =
    lastCtxPlus >= 0 &&
    lastCtxPlus + 1 < body.length &&
    body[lastCtxPlus + 1].startsWith('\\');
  const noNlPlus =
    lastPlus >= 0 &&
    lastPlus + 1 < body.length &&
    body[lastPlus + 1].startsWith('\\');
  return {
    next: j,
    hunk: {
      a: 0,
      oLines,
      nLines,
      nCtx,
      noNlCtxPlus,
      noNlPlus,
      hasPlus: lastPlus >= 0,
    },
  };
}

function parseUnified(lines) {
  const sections = [];
  let cur = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (!m) throw parseFail(i + 1);
      cur = {
        diffA: m[1],
        diffB: m[2],
        pairOld: undefined,
        pairNew: undefined,
        hasPair: false,
        renameFrom: undefined,
        renameTo: undefined,
        newFile: false,
        delFile: false,
        hunks: [],
        state: 'header',
      };
      sections.push(cur);
      i++;
      continue;
    }
    if (
      l.startsWith('--- ') &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith('+++ ')
    ) {
      if (!(cur && cur.state === 'header' && !cur.hasPair)) {
        cur = {
          diffA: undefined,
          diffB: undefined,
          pairOld: undefined,
          pairNew: undefined,
          hasPair: false,
          renameFrom: undefined,
          renameTo: undefined,
          newFile: false,
          delFile: false,
          hunks: [],
          state: 'header',
        };
        sections.push(cur);
      }
      cur.pairOld = unifiedPath(l.slice(4));
      cur.pairNew = unifiedPath(lines[i + 1].slice(4));
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur && cur.state === 'header') throw parseFail(i + 2);
      i++;
      continue;
    }
    if (l.startsWith('+++ ')) {
      if (cur && cur.state === 'header') cur.pairNew = unifiedPath(l.slice(4));
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (!cur) throw parseFail(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) throw parseFail(i + 1);
      const parsed = parseHunkBody(lines, i + 1);
      parsed.hunk.a = Number(m[1]);
      cur.hunks.push(parsed.hunk);
      cur.state = 'hunks';
      i = parsed.next;
      continue;
    }
    if (cur && cur.state === 'header') {
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
      } else if (l.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.delFile = true;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw parseFail(1);
  return sections;
}

function applyUnified(tree, sec, strict) {
  let oldP;
  let newP;
  if (sec.hasPair) {
    oldP = sec.pairOld;
    newP = sec.pairNew;
  } else {
    oldP = sec.renameFrom !== undefined ? sec.renameFrom : sec.diffA;
    newP = sec.renameTo !== undefined ? sec.renameTo : sec.diffB;
  }
  let kind;
  if (sec.newFile) kind = 'create';
  else if (sec.delFile) kind = 'delete';
  else if (oldP === null || oldP === undefined) kind = 'create';
  else if (newP === null || newP === undefined) kind = 'delete';
  else if (oldP !== newP) kind = 'move';
  else kind = 'change';

  if (kind === 'create') {
    const p = newP !== null && newP !== undefined ? newP : sec.diffB;
    const path = p !== undefined ? p : oldP;
    if (!isSafePath(path)) return { code: 'unsafe', path };
    if (tree.exists(path)) return { code: 'exists', path };
    const plusLines = [];
    let noNl = false;
    for (const h of sec.hunks) {
      for (let k = 0; k < h.nLines.length; k++) {
        if (h.nCtx[k] === -1) plusLines.push(h.nLines[k]);
      }
    }
    for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
      if (sec.hunks[hi].hasPlus) {
        noNl = sec.hunks[hi].noNlPlus;
        break;
      }
    }
    let content = '';
    if (plusLines.length > 0) {
      content = plusLines.join('\n') + (noNl ? '' : '\n');
    }
    tree.set(path, content);
    return null;
  }

  if (kind === 'delete') {
    const p = oldP !== null && oldP !== undefined ? oldP : sec.diffA;
    const path = p !== undefined ? p : newP;
    if (!isSafePath(path)) return { code: 'unsafe', path };
    if (!tree.exists(path)) return { code: 'missing', path };
    tree.delete(path);
    return null;
  }

  if (kind === 'move') {
    const oldPath = oldP !== undefined ? oldP : sec.diffA;
    const newPath = newP !== undefined ? newP : sec.diffB;
    if (!isSafePath(oldPath)) return { code: 'unsafe', path: oldPath };
    if (!isSafePath(newPath)) return { code: 'unsafe', path: newPath };
    if (!tree.exists(oldPath)) return { code: 'missing', path: oldPath };
    if (tree.exists(newPath)) return { code: 'exists', path: newPath };
    const res = applyUnifiedHunks(tree, oldPath, sec, strict, newPath);
    if (res) return res;
    return null;
  }

  const path = oldP !== undefined ? oldP : newP;
  if (!isSafePath(path)) return { code: 'unsafe', path };
  if (!tree.exists(path)) return { code: 'missing', path };
  return applyUnifiedHunks(tree, path, sec, strict, null);
}

function applyUnifiedHunks(tree, path, sec, strict, moveTo) {
  const f = parseFile(tree.get(path));
  let d = 0;
  for (const h of sec.hunks) {
    if (h.oLines.length > 0) {
      const found = findTier(f.lines, h.oLines, strict, () => true);
      if (!found) return { code: 'no-match', path };
      const target = h.a - 1 + d;
      let best = found.occs[0];
      let bestDist = Math.abs(best - target);
      for (const pos of found.occs) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const newLines = buildN(f.lines, best, h.oLines, h.nLines, h.nCtx, found.tier);
      const runsToEnd = best + h.oLines.length === f.lines.length;
      f.lines.splice(best, h.oLines.length, ...newLines);
      if (runsToEnd) f.endBreak = !h.noNlCtxPlus;
      d += h.nLines.length - h.oLines.length;
    } else {
      const idx = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = idx === f.lines.length;
      f.lines.splice(idx, 0, ...h.nLines);
      if (atEnd) f.endBreak = !h.noNlCtxPlus;
      d += h.nLines.length;
    }
  }
  const content = serializeFile(f);
  if (moveTo) {
    tree.move(path, moveTo, content);
  } else {
    tree.set(path, content);
  }
  return null;
}

// ---- section 7: SEARCH/REPLACE blocks ----

function parseSearchReplace(lines) {
  const blocks = [];
  let prevEnd = 0;
  let prevPath = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, '') !== '<<<<<<< SEARCH') continue;
    let path = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw parseFail(i + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k].replace(/\s+$/, '');
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw parseFail(i + 1);
    let gt = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k].replace(/\s+$/, '') === '>>>>>>> REPLACE') {
        gt = k;
        break;
      }
    }
    if (gt === -1) throw parseFail(i + 1);
    blocks.push({
      path,
      oldLines: lines.slice(i + 1, eq),
      newLines: lines.slice(eq + 1, gt),
    });
    prevPath = path;
    prevEnd = gt + 1;
    i = gt;
  }
  if (blocks.length === 0) throw parseFail(1);
  return blocks;
}

function applySearchReplace(tree, block, strict) {
  const path = block.path;
  if (!isSafePath(path)) return { code: 'unsafe', path };
  if (block.oldLines.length === 0) {
    if (tree.exists(path)) return { code: 'exists', path };
    tree.set(path, serializeCreated(block.newLines));
    return null;
  }
  if (!tree.exists(path)) return { code: 'missing', path };
  const f = parseFile(tree.get(path));
  const nCtx = block.newLines.map(() => -1);
  const found = findTier(f.lines, block.oldLines, strict, () => true);
  if (!found) return { code: 'no-match', path };
  if (found.occs.length > 1) return { code: 'ambiguous', path };
  const pos = found.occs[0];
  const newLines = buildN(
    f.lines,
    pos,
    block.oldLines,
    block.newLines,
    nCtx,
    found.tier,
  );
  f.lines.splice(pos, block.oldLines.length, ...newLines);
  tree.set(path, serializeFile(f));
  return null;
}

// ---- section 8: V4A patches ----

function chunkBodyLines(body) {
  const oLines = [];
  const nLines = [];
  const nCtx = [];
  for (const b of body) {
    if (b === '' || b.startsWith(' ')) {
      const t = b === '' ? '' : b.slice(1);
      oLines.push(t);
      nLines.push(t);
      nCtx.push(oLines.length - 1);
    } else if (b.startsWith('-')) {
      oLines.push(b.slice(1));
    } else if (b.startsWith('+')) {
      nLines.push(b.slice(1));
      nCtx.push(-1);
    }
  }
  return { oLines, nLines, nCtx };
}

function parseV4a(lines) {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw parseFail(1);
  if (lines[first].trim() !== '*** Begin Patch') throw parseFail(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') {
    throw parseFail(lines.length + 1);
  }

  const sections = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (l.trim() === '') {
      i++;
      continue;
    }
    let kind = null;
    let path = null;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw parseFail(i + 1);
    }
    const headerLine = i + 1;
    i++;
    const raw = [];
    const rawLines = [];
    while (i < last) {
      const r = lines[i];
      if (
        r.startsWith('*** Add File: ') ||
        r.startsWith('*** Delete File: ') ||
        r.startsWith('*** Update File: ')
      ) {
        break;
      }
      raw.push(r);
      rawLines.push(i + 1);
      i++;
    }
    while (raw.length > 0 && raw[raw.length - 1].trim() === '') {
      raw.pop();
      rawLines.pop();
    }
    if (kind === 'add') {
      const fileLines = [];
      for (let k = 0; k < raw.length; k++) {
        if (raw[k] === '') fileLines.push('');
        else if (raw[k].startsWith('+')) fileLines.push(raw[k].slice(1));
        else throw parseFail(rawLines[k]);
      }
      sections.push({ kind, path, fileLines });
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (raw[k].trim() !== '') throw parseFail(rawLines[k]);
      }
      sections.push({ kind, path });
    } else {
      let moveTo = null;
      let k = 0;
      if (raw.length > 0 && raw[0].startsWith('*** Move to: ')) {
        moveTo = raw[0].slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks = [];
      let cur = null;
      let started = false;
      for (; k < raw.length; k++) {
        const r = raw[k];
        if (r.startsWith('@@')) {
          if (cur) chunks.push(cur);
          cur = {
            anchor: r.slice(2).trim() === '' ? null : r.slice(2).trim(),
            body: [],
            endAnchored: false,
          };
          started = true;
        } else if (r === '*** End of File') {
          if (!cur) throw parseFail(rawLines[k]);
          cur.endAnchored = true;
          chunks.push(cur);
          cur = null;
        } else if (r === '' || r.startsWith(' ') || r.startsWith('-') || r.startsWith('+')) {
          if (!cur) {
            if (started) throw parseFail(rawLines[k]);
            cur = { anchor: null, body: [], endAnchored: false };
            started = true;
          }
          cur.body.push(r);
        } else {
          throw parseFail(rawLines[k]);
        }
      }
      if (cur) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) {
        throw parseFail(headerLine);
      }
      for (const c of chunks) {
        const built = chunkBodyLines(c.body);
        c.oLines = built.oLines;
        c.nLines = built.nLines;
        c.nCtx = built.nCtx;
        delete c.body;
      }
      sections.push({ kind, path, moveTo, chunks });
    }
  }
  if (sections.length === 0) throw parseFail(1);
  return sections;
}

function applyV4a(tree, sec, strict) {
  if (sec.kind === 'add') {
    if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
    if (tree.exists(sec.path)) return { code: 'exists', path: sec.path };
    tree.set(sec.path, serializeCreated(sec.fileLines));
    return null;
  }
  if (sec.kind === 'delete') {
    if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
    if (!tree.exists(sec.path)) return { code: 'missing', path: sec.path };
    tree.delete(sec.path);
    return null;
  }
  if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
  if (sec.moveTo !== null && sec.moveTo !== undefined) {
    if (!isSafePath(sec.moveTo)) return { code: 'unsafe', path: sec.moveTo };
  }
  if (!tree.exists(sec.path)) return { code: 'missing', path: sec.path };
  if (
    sec.moveTo !== null &&
    sec.moveTo !== undefined &&
    tree.exists(sec.moveTo)
  ) {
    return { code: 'exists', path: sec.moveTo };
  }
  const f = parseFile(tree.get(sec.path));
  let cursor = 0;
  for (const chunk of sec.chunks) {
    if (chunk.anchor !== null) {
      let anchorIdx = -1;
      const maxTier = strict ? 0 : 2;
      for (let tier = 0; tier <= maxTier && anchorIdx === -1; tier++) {
        for (let li = cursor; li < f.lines.length; li++) {
          if (lineEq(f.lines[li], chunk.anchor, tier)) {
            anchorIdx = li;
            break;
          }
        }
      }
      if (anchorIdx === -1) return { code: 'no-match', path: sec.path };
      cursor = anchorIdx + 1;
    }
    if (chunk.oLines.length > 0) {
      const filter = chunk.endAnchored
        ? (pos) => pos + chunk.oLines.length === f.lines.length
        : () => true;
      const found = findTier(f.lines, chunk.oLines, strict, (pos) => {
        if (pos < cursor) return false;
        return filter(pos);
      });
      if (!found) return { code: 'no-match', path: sec.path };
      const pos = found.occs[0];
      const newLines = buildN(
        f.lines,
        pos,
        chunk.oLines,
        chunk.nLines,
        chunk.nCtx,
        found.tier,
      );
      f.lines.splice(pos, chunk.oLines.length, ...newLines);
      cursor = pos + newLines.length;
    } else {
      const idx = chunk.endAnchored ? f.lines.length : cursor;
      f.lines.splice(idx, 0, ...chunk.nLines);
      cursor = idx + chunk.nLines.length;
    }
  }
  const content = serializeFile(f);
  if (sec.moveTo !== null && sec.moveTo !== undefined) {
    tree.move(sec.path, sec.moveTo, content);
  } else {
    tree.set(sec.path, content);
  }
  return null;
}

// ---- section 9: JSON edits ----

function lineOfFirstNonWs(text) {
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') line++;
    else if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') continue;
    else return line;
  }
  return 1;
}

function validateJsonEdit(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { command: 'create', path: o.path, file_text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    let newStr = o.new_str;
    if (newStr === undefined) newStr = '';
    if (typeof newStr !== 'string') return null;
    return { command: 'str_replace', path: o.path, old_str: o.old_str, new_str: newStr };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { command: 'insert', path: o.path, insert_line: o.insert_line, new_str: o.new_str };
  }
  return null;
}

function parseJson(patchText, lines) {
  let arr = null;
  try {
    const v = JSON.parse(patchText);
    if (Array.isArray(v)) arr = v;
  } catch {
    arr = null;
  }
  if (arr !== null) {
    const startLine = lineOfFirstNonWs(patchText);
    const edits = [];
    for (const el of arr) {
      const e = validateJsonEdit(el);
      if (!e) throw parseFail(startLine);
      edits.push(e);
    }
    if (edits.length === 0) throw parseFail(1);
    return edits;
  }
  const edits = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(l);
    } catch {
      throw parseFail(i + 1);
    }
    const e = validateJsonEdit(obj);
    if (!e) throw parseFail(i + 1);
    edits.push(e);
  }
  if (edits.length === 0) throw parseFail(1);
  return edits;
}

function countOverlapping(text, needle) {
  let count = 0;
  let idx = 0;
  while (true) {
    const at = text.indexOf(needle, idx);
    if (at === -1) return count;
    count++;
    idx = at + 1;
  }
}

function applyJson(tree, edit) {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (edit.command === 'create') {
    if (tree.exists(edit.path)) return { code: 'exists', path: edit.path };
    tree.set(edit.path, edit.file_text);
    return null;
  }
  if (!tree.exists(edit.path)) return { code: 'missing', path: edit.path };
  if (edit.command === 'str_replace') {
    const content = tree.get(edit.path);
    const f = parseFile(content);
    const isCrlf = f.eol === '\r\n';
    let text = content;
    let oldS = edit.old_str;
    let newS = edit.new_str;
    if (isCrlf) {
      text = content.replace(/\r\n/g, '\n');
      oldS = edit.old_str.replace(/\r\n/g, '\n');
      newS = edit.new_str.replace(/\r\n/g, '\n');
    }
    const count = countOverlapping(text, oldS);
    if (count === 0) return { code: 'no-match', path: edit.path };
    if (count > 1) return { code: 'ambiguous', path: edit.path };
    const at = text.indexOf(oldS);
    let result = text.slice(0, at) + newS + text.slice(at + oldS.length);
    if (isCrlf) result = result.replace(/\n/g, '\r\n');
    tree.set(edit.path, result);
    return null;
  }
  const f = parseFile(tree.get(edit.path));
  if (edit.insert_line < 0 || edit.insert_line > f.lines.length) {
    return { code: 'no-match', path: edit.path };
  }
  const newLines =
    edit.new_str === '' ? [] : splitPatchLines(edit.new_str);
  f.lines.splice(edit.insert_line, 0, ...newLines);
  tree.set(edit.path, serializeFile(f));
  return null;
}

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}

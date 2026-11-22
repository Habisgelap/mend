// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON
// edits), finds the lines each edit names at the first of three matching tiers, and writes
// every change or none, printing what it changed or why it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text split into lines, with its own line break and whether it ends with one. */
interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  ends: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function writeFileText(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.ends ? st.br : '');
}

const lead = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  const t = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return t(a) === t(b);
}

function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(file[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function findTier(file: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(file, o, t).filter((i) => i >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: `text` is the patch's text; `ctx` is its index in O when it is a context line. */
interface NLine {
  text: string;
  ctx: number | null;
}

/** The lines that replace O at `at`: context lines are the file's own matched lines; at tier 2
 *  every other line is re-indented from O's first line's leading whitespace to the file's. */
function buildReplacement(fileLines: string[], o: string[], n: NLine[], at: number, tier: number): string[] {
  const f = tier === 2 ? lead(fileLines[at] ?? '') : '';
  const p = tier === 2 ? lead(o[0] ?? '') : '';
  return n.map((nl) => {
    if (nl.ctx !== null) return fileLines[at + nl.ctx]!;
    if (tier !== 2) return nl.text;
    const t = nl.text;
    if (t === '' || t.trim() === '') return t;
    return t.startsWith(p) ? f + t.slice(p.length) : t;
  });
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  create: boolean; // `new file mode`
  del: boolean; // `deleted file mode`
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- `/`+++ `: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

const toNull = (p: string): string | null => (p === '/dev/null' ? null : p.replace(/^[ab]\//, ''));
const rawOf = (p: string | null): string => (p === null ? '/dev/null' : p);

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  interface Raw {
    pairOld?: string | null;
    pairNew?: string | null;
    renameFrom?: string;
    renameTo?: string;
    diffOld?: string;
    diffNew?: string;
    create: boolean;
    del: boolean;
    hasPair: boolean;
    hunks: Hunk[];
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  let inHeader = false;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: toNull(m[1]!), diffNew: toNull(m[2]!), create: false, del: false, hasPair: false, hunks: [] };
      raws.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.pairOld = toNull(headerPath(line));
        cur.pairNew = toNull(headerPath(lines[i + 1]!));
        cur.hasPair = true;
        i += 2;
        continue;
      }
      cur = { pairOld: toNull(headerPath(line)), pairNew: toNull(headerPath(lines[i + 1]!)), create: false, del: false, hasPair: true, hunks: [] };
      raws.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: parseInt(m[1]!, 10), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any
      // other line are ignored.
      i++;
      continue;
    }
    // Between or after hunks: ignored (prose, code fences).
    i++;
  }
  const sections: UniSection[] = raws.map((r) => ({
    oldPath: r.pairOld !== undefined ? r.pairOld : r.renameFrom !== undefined ? toNull(r.renameFrom) : r.diffOld !== undefined ? r.diffOld : null,
    newPath: r.pairNew !== undefined ? r.pairNew : r.renameTo !== undefined ? toNull(r.renameTo) : r.diffNew !== undefined ? r.diffNew : null,
    create: r.create,
    del: r.del,
    hunks: r.hunks,
  }));
  return sections.map((s) => unifiedEdit(s, strict));
}

/** O, N and the no-newline flag of one hunk body. */
function hunkParts(body: string[]): { o: string[]; n: NLine[]; noEol: boolean } {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxPlus = -1;
  body.forEach((l, idx) => {
    if (l === '' || l[0] === ' ') {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: o.length - 1 });
      lastCtxPlus = idx;
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: null });
      lastCtxPlus = idx;
    }
    // `\` lines refer to the body line before them; they add no line of their own.
  });
  const noEol = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]![0] === '\\';
  return { o, n, noEol };
}

/** Whether a `\` line follows the last `+` line of a hunk body (null: no `+` line). */
function plusNoEol(body: string[]): boolean | null {
  let last = -1;
  body.forEach((l, idx) => {
    if (l[0] === '+') last = idx;
  });
  if (last < 0) return null;
  return body[last + 1] !== undefined && body[last + 1]![0] === '\\';
}

function applyHunk(st: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  const { o, n, noEol } = hunkParts(h.body);
  const lines = [...st.lines];
  let ends = st.ends;
  if (o.length > 0) {
    const found = findTier(lines, o, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + o.length === lines.length;
    const rep = buildReplacement(lines, o, n, best, found.tier);
    lines.splice(best, o.length, ...rep);
    if (atEnd) ends = !noEol;
  } else {
    const pos = Math.min(Math.max(h.a + d, 0), lines.length);
    lines.splice(pos, 0, ...n.map((x) => x.text));
    if (pos === lines.length) ends = !noEol;
  }
  return { lines, br: st.br, ends };
}

function applyHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let d = 0;
  let cur = st;
  for (const h of hunks) {
    const parts = hunkParts(h.body);
    cur = applyHunk(cur, h, d, strict, path);
    d += parts.n.length - parts.o.length;
  }
  return cur;
}

function unifiedEdit(s: UniSection, strict: boolean): Edit {
  return (tree: Tree) => {
    if (s.oldPath !== null && !safe(s.oldPath)) throw new Fail('unsafe', rawOf(s.oldPath));
    if (s.newPath !== null && !safe(s.newPath)) throw new Fail('unsafe', rawOf(s.newPath));
    const isCreate = s.create || s.oldPath === null;
    const isDelete = !isCreate && (s.del || s.newPath === null);
    if (isCreate) {
      const target = s.newPath;
      if (target === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        const parts = hunkParts(h.body);
        for (const nl of parts.n) if (nl.ctx === null) plus.push(nl.text);
        const f = plusNoEol(h.body);
        if (f !== null) noEol = f;
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = s.oldPath;
      if (target === null) throw new Fail('missing', '/dev/null');
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const oldP = s.oldPath!;
    const newP = s.newPath!;
    if (oldP !== newP) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(parseFile(tree.get(oldP)!), s.hunks, strict, oldP);
      tree.now.set(newP, writeFileText(out));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    const out = applyHunks(parseFile(tree.get(oldP)!), s.hunks, strict, oldP);
    tree.now.set(oldP, writeFileText(out));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const blocks: SrBlock[] = [];
  let prevEnd = -1; // index of the previous block's `>>>>>>> REPLACE` line
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const st = parseFile(cur);
    const found = findTier(st.lines, b.oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.occ[0]!;
    const nlines: NLine[] = b.newLines.map((t) => ({ text: t, ctx: null }));
    const rep = buildReplacement(st.lines, b.oldLines, nlines, at, found.tier);
    const lines = [...st.lines];
    lines.splice(at, b.oldLines.length, ...rep);
    tree.now.set(b.path, writeFileText({ lines, br: st.br, ends: st.ends }));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number; // 1-based line of the section's header, for parse errors
  moveTo: string | null;
  chunks: VChunk[];
  addLines: string[];
}

const V_SECTION_RE = /^\*\*\* (Add|Delete|Update) File: (.*)$/;
const isVSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const m = V_SECTION_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!.toLowerCase() as 'add' | 'delete' | 'update';
    const sec: VSection = { kind, path: m[2]!.trim(), line: i + 1, moveTo: null, chunks: [], addLines: [] };
    sections.push(sec);
    i++;
    if (kind === 'add') {
      const raw: string[] = [];
      while (i < last && !isVSectionStart(lines[i]!)) {
        raw.push(lines[i]!);
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) sec.addLines.push(l.slice(1));
        else if (l === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${i - raw.length + k + 1}`);
      }
      continue;
    }
    if (kind === 'delete') {
      while (i < last && !isVSectionStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      continue;
    }
    // Update File: optional `*** Move to:` first, then chunks.
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i++;
    }
    const raw: string[] = [];
    while (i < last && !isVSectionStart(lines[i]!)) {
      raw.push(lines[i]!);
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    let chunk: VChunk | null = null;
    const base = i - raw.length; // 0-based index of raw[0]
    raw.forEach((l, k) => {
      const ln = base + k + 1; // 1-based line number
      if (l === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${ln}`);
        chunk.eof = true;
        chunk = null;
        return;
      }
      if (l.startsWith('@@')) {
        const anchor = l.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        sec.chunks.push(chunk);
        return;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        if (chunk === null) {
          if (sec.chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
          chunk = { anchor: null, eof: false, body: [] };
          sec.chunks.push(chunk);
        }
        chunk.body.push(l);
        return;
      }
      throw new Exit2(`error: parse ${ln}`);
    });
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
  }
  return sections.map((s) => v4aEdit(s, strict));
}

/** O and N of one V4A chunk body. */
function vChunkParts(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: null });
    }
  }
  return { o, n };
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let st = parseFile(cur);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        let found = -1;
        const max = strict ? 0 : 2;
        for (let t = 0; t <= max && found < 0; t++) {
          for (let k = cursor; k < st.lines.length; k++) {
            if (lineEq(st.lines[k]!, chunk.anchor, t)) {
              found = k;
              break;
            }
          }
        }
        if (found < 0) throw new Fail('no-match', s.path);
        cursor = found + 1;
      }
      const { o, n } = vChunkParts(chunk.body);
      if (o.length === 0) {
        const pos = chunk.eof ? st.lines.length : cursor;
        const lines = [...st.lines];
        lines.splice(pos, 0, ...n.map((x) => x.text));
        st = { lines, br: st.br, ends: st.ends };
        cursor = pos + n.length;
        continue;
      }
      const max = strict ? 0 : 2;
      let hit: { tier: number; at: number } | null = null;
      for (let t = 0; t <= max && hit === null; t++) {
        const occ = occurrences(st.lines, o, t).filter((p) => p >= cursor && (!chunk.eof || p + o.length === st.lines.length));
        if (occ.length > 0) hit = { tier: t, at: occ[0]! };
      }
      if (hit === null) throw new Fail('no-match', s.path);
      const rep = buildReplacement(st.lines, o, n, hit.at, hit.tier);
      const lines = [...st.lines];
      lines.splice(hit.at, o.length, ...rep);
      st = { lines, br: st.br, ends: st.ends };
      cursor = hit.at + rep.length;
    }
    const text = writeFileText(st);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, text);
      tree.now.set(s.path, null);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, text);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Command line and output (SPEC.md sections 1, 2 and 10)              */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const coveredOld = new Set<string>();
  const coveredNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      coveredOld.add(oldP);
      coveredNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (coveredOld.has(p) || coveredNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

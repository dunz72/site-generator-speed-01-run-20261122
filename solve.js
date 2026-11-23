// Fast drop-in for makefun-site 1.0.0 — an independent, from-scratch reimplementation
// of its documented behaviour (README.md of makefun-site 1.0.0), written for speed:
// chunk-based HTML escaping, a single-pass Markdown renderer (no token objects),
// cached slug/date work, memoised link resolution and an output-array template
// renderer. Returns byte-identical answers to makefun-site 1.0.0's build().

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " ' escaped. */
function escapeHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The slug of `text` (NFKD, combining marks dropped, A-Z lowered, runs of other
 *  characters one "-", at most 64 chars, "untitled" when empty), cached per run. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone, cached per run. */
function longDate(date, cache) {
  let v = cache.get(date);
  if (v !== undefined) return v;
  v = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  cache.set(date, v);
  return v;
}

/** The words of a body: its runs of characters other than whitespace (counted without allocating). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 32 || (c >= 9 && c <= 13);
    else ws = c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** `rel` (a link's path) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const BLANK_RE = /^[ \t]*$/;
const TRAIL_RE = /[ \t]+$/;
const KEY_RE = /^[a-z_]+$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error } with the first reason it is refused. */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  if ((nl === -1 ? text : text.slice(0, nl)) !== '---') return { error: 'no front matter' };
  // Find the closing line and remember where it starts/ends.
  let pos = nl + 1;
  let closeStart = -1;
  let closeEnd = -1;
  let ln = 2;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const lineEnd = e === -1 ? text.length : e;
    if (text.slice(pos, lineEnd) === '---') { closeStart = pos; closeEnd = lineEnd; break; }
    if (e === -1) break;
    pos = e + 1;
    ln++;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = nl + 1;
  let n = 2;
  while (p < closeStart) {
    const e = text.indexOf('\n', p);
    const lineEnd = e === -1 ? text.length : e;
    const line = text.slice(p, lineEnd);
    if (!BLANK_RE.test(line) && line[0] !== '#') {
      const c = line.indexOf(':');
      if (c <= 0) return { error: `line ${n} is not "key: value"` };
      const key = line.slice(0, c);
      if (!KEY_RE.test(key)) return { error: `line ${n} is not "key: value"` };
      let raw;
      if (c === line.length - 1) raw = '';
      else if (line[c + 1] === ' ') raw = line.slice(c + 2);
      else return { error: `line ${n} is not "key: value"` };
      raw = raw.replace(TRAIL_RE, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (e === -1) break;
    p = e + 1;
    n++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd >= text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c = line[0];
  if (c === undefined) return true;
  if (c === ' ' || c === '\t') return BLANK.test(line);
  if (c === '`') return FENCE_OPEN.test(line);
  if (c === '#') {
    const hm = HEADING.exec(line);
    return hm !== null && hm[2] !== '';
  }
  if (c === '-' || c === '*') return HR.test(line);
  return false;
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_RE = /[\\`*\[]|[&<>"']/g;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    // Fast path: no backslash between here and the candidate, so no escape can hide it.
    const bs = s.indexOf('\\', j);
    if (bs === -1 || bs >= k) return k;
    let p = j;
    while (p < k) {
      if (s[p] === '\\' && p + 1 < s.length && ESCAPABLE.has(s[p + 1])) p += 2;
      else p++;
    }
    if (p === k) return k;
    j = k + 1;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    const bs = s.indexOf('\\', j);
    if (bs === -1 || bs >= k) {
      if (s[k + 1] === '*') { j = k + 2; continue; }
      return k;
    }
    let p = j;
    while (p < k) {
      if (s[p] === '\\' && p + 1 < s.length && ESCAPABLE.has(s[p + 1])) p += 2;
      else p++;
    }
    if (p === k) {
      if (s[k + 1] === '*') { j = k + 2; continue; }
      return k;
    }
    j = k + 1;
  }
}

/** `s` rendered inline; `S.link(target)` is a link's href. */
function inline(s, S) {
  const out = [];
  const len = s.length;
  let i = 0;
  while (i < len) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null) {
      out.push(s.slice(i));
      break;
    }
    const p = m.index;
    if (p > i) out.push(s.slice(i, p));
    const c = s[p];
    const esc = ESCAPES[c];
    if (esc !== undefined) {
      out.push(esc);
      i = p + 1;
      continue;
    }
    if (c === '\\') {
      if (p + 1 < len && ESCAPABLE.has(s[p + 1])) { out.push(ESCAPES[s[p + 1]] ?? s[p + 1]); i = p + 2; }
      else { out.push('\\'); i = p + 1; }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', p + 1);
      if (j > p + 1) { out.push(`<code>${escapeHtml(s.slice(p + 1, j))}</code>`); i = j + 1; }
      else { out.push('`'); i = p + 1; }
      continue;
    }
    if (c === '*') {
      if (s[p + 1] === '*') {
        const j = findUnescaped(s, '**', p + 2);
        if (j > p + 2) { out.push(`<strong>${inline(s.slice(p + 2, j), S)}</strong>`); i = j + 2; }
        else { out.push('**'); i = p + 2; }
      } else {
        const j = findSingleStar(s, p + 1);
        if (j > p + 1) { out.push(`<em>${inline(s.slice(p + 1, j), S)}</em>`); i = j + 1; }
        else { out.push('*'); i = p + 1; }
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', p + 1);
    const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !/\s/.test(target)) {
      out.push(`<a href="${escapeHtml(S.link(target))}">${inline(s.slice(p + 1, k), S)}</a>`);
      i = m2 + 1;
    } else {
      out.push('[');
      i = p + 1;
    }
  }
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, S) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line[0];
    if (c0 === undefined || c0 === ' ' || c0 === '\t') {
      if (isBlank(line)) { i++; continue; }
      // A line opening on a space or tab is a paragraph line: no block opens on it.
    } else if (c0 === '`') {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        let j = i + 1;
        const body = [];
        while (j < n && !FENCE_CLOSE.test(lines[j])) body.push(lines[j++]);
        out.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>${body.map((l) => `${escapeHtml(l)}\n`).join('')}</code></pre>\n`);
        i = j + 1;
        continue;
      }
    } else if (c0 === '#') {
      const hm = HEADING.exec(line);
      if (hm !== null && hm[2] !== '') {
        const text = hm[2];
        const depth = hm[1].length;
        const id = uniqueSlug(slugify(text, S.slugCache), ids);
        const html = inline(text, S);
        out.push(`<h${depth} id="${id}">${html}</h${depth}>\n`);
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (HR.test(line)) { out.push('<hr>\n'); i++; continue; }
    } else if (c0 === '>') {
      const parts = [];
      while (i < n && lines[i][0] === '>') {
        const t = trimLine(lines[i].replace(/^> ?/, ''));
        if (t !== '') parts.push(t);
        i++;
      }
      out.push(parts.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(parts.join('\n'), S)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= '0' && c0 <= '9') {
      const om = ORDERED.exec(line);
      if (om !== null) {
        const items = [];
        const start = Number(om[1]);
        while (i < n) {
          const m = ORDERED.exec(lines[i]);
          if (m !== null) { items.push(trimLine(m[2])); i++; }
          else if (CONTINUED.test(lines[i])) { items[items.length - 1] += `\n${trimLine(lines[i])}`; i++; }
          else break;
        }
        let block = start !== 1 ? `<ol start="${start}">\n` : '<ol>\n';
        for (const it of items) block += `<li>${inline(it, S)}</li>\n`;
        block += '</ol>\n';
        out.push(block);
        continue;
      }
    }
    if ((c0 === '-' || c0 === '*') && line[1] === ' ') {
      // A bullet list (a line "- " or "* "); an ordered list is handled above.
      const items = [];
      while (i < n) {
        const m = BULLET.exec(lines[i]);
        if (m !== null) { items.push(trimLine(m[1])); i++; }
        else if (CONTINUED.test(lines[i])) { items[items.length - 1] += `\n${trimLine(lines[i])}`; i++; }
        else break;
      }
      let block = '<ul>\n';
      for (const it of items) block += `<li>${inline(it, S)}</li>\n`;
      block += '</ul>\n';
      out.push(block);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) { body.push(trimLine(lines[i])); i++; }
    const html = inline(body.join('\n'), S);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` in `scope` ({ vars, parent }); `ctx` holds the parsed templates and the HTML escape. */
function renderInto(nodes, scope, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.kind) {
      case 'text':
        out.push(node.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, node.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, node.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, node.path));
        const branch = v !== node.not ? node.then : node.else;
        if (branch !== null) renderInto(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, node.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [node.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderInto(node.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(node.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInto(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/** The guarded own-property step of a compiled path: the value at `k` of `v`, or undefined. */
function pathStep(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/** A compiled path expression: its first name read off the scope chain (a null-prototype
 *  chain, so a missing name is undefined), each next name a guarded own-property step. */
function pathExpr(path, depth) {
  let e = `S${depth}[${JSON.stringify(path[0])}]`;
  for (let k = 1; k < path.length; k++) e = `H.G(${e},${JSON.stringify(path[k])})`;
  return e;
}

/** `nodes` compiled to JS statements rendering into `out`, using scope variable `S<depth>`. */
function compileNodes(nodes, depth, st) {
  let code = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        code += `out.push(${JSON.stringify(node.text)});\n`;
        break;
      case 'var':
        code += `out.push(H.escText(${pathExpr(node.path, depth)}));\n`;
        break;
      case 'raw':
        code += `out.push(H.textOf(${pathExpr(node.path, depth)}));\n`;
        break;
      case 'if': {
        code += `if (H.truthy(${pathExpr(node.path, depth)}) !== ${node.not}) {\n${compileNodes(node.then, depth, st)}`;
        if (node.else !== null) code += `} else {\n${compileNodes(node.else, depth, st)}`;
        code += `}\n`;
        break;
      }
      case 'for': {
        const id = st.n++;
        const xs = `_xs${id}`;
        const sc = `S${depth + 1}`;
        const lp = `_l${id}`;
        const kk = `_k${id}`;
        code += `{\nconst ${xs} = ${pathExpr(node.path, depth)};\nif (Array.isArray(${xs})) {\n`;
        code += `const ${sc} = Object.create(S${depth});\n`;
        code += `const ${lp} = { index: 0, first: false, last: false, length: ${xs}.length };\n`;
        code += `${sc}["loop"] = ${lp};\n`;
        code += `for (let ${kk} = 0; ${kk} < ${xs}.length; ${kk}++) {\n`;
        code += `${sc}[${JSON.stringify(node.name)}] = ${xs}[${kk}];\n`;
        code += `${lp}.index = ${kk} + 1; ${lp}.first = ${kk} === 0; ${lp}.last = ${kk} === ${xs}.length - 1;\n`;
        code += compileNodes(node.body, depth + 1, st);
        code += `}\n}\n}\n`;
        break;
      }
      case 'include': {
        const id = st.n++;
        code += `{\nconst _f${id} = T.get(${JSON.stringify(node.name)});\nif (_f${id} !== undefined && D < ${INCLUDE_DEPTH}) _f${id}(S${depth}, D + 1, out, H, T);\n}\n`;
        break;
      }
    }
  }
  return code;
}

const COMPILE_HELPERS = { textOf, truthy, escape: escapeHtml, G: pathStep, escText: (v) => (typeof v === 'string' ? escapeHtml(v) : escapeHtml(textOf(v))) };

/** Every parsed template compiled to a function (S0, D, out, H, T); null when compilation is unavailable. */
function compileAll(parsed) {
  const T = new Map();
  for (const [name, nodes] of parsed) {
    const body = compileNodes(nodes, 0, { n: 0 });
    T.set(name, new Function('S0', 'D', 'out', 'H', 'T', body));
  }
  return T;
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
function linkOf(S, s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, S.dateCache) };
}

/** A post's card, as lists show it. */
function cardOf(S, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, S.dateCache),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(S, s) {
  const card = s.post ? S.cards.get(s) : cardOf(S, s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(S, s.newer ?? null),
    older: linkOf(S, s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const S = {
    slugCache: new Map(),
    dateCache: new Map(),
    linkCache: new Map(),
    brokenKeys: new Set(),
    broken: new Set(),
    report: [],
    templates: new Map(),
    bySource: new Map(),
    staticPaths: new Set(),
    base: '',
    dir: '',
    curPath: '',
  };
  const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  S.link = (target) => {
    if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
    const key = `${S.dir}\n${target}`;
    const hit = S.linkCache.get(key);
    if (hit !== undefined) {
      if (S.brokenKeys.has(key)) S.broken.add(`broken-link ${S.curPath} -> ${target}`);
      return hit;
    }
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(S.dir, rel);
    let href;
    if (path !== null && S.bySource.has(path)) href = `${S.bySource.get(path).url}${frag}`;
    else if (path !== null && S.staticPaths.has(path)) href = `${S.base}/${path}${frag}`;
    else {
      S.broken.add(`broken-link ${S.curPath} -> ${target}`);
      S.brokenKeys.add(key);
      href = target;
    }
    S.linkCache.set(key, href);
    return href;
  };

  // Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      S.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      S.report.push(err.message);
    }
  }
  S.base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of path; line ends made "\n"; a non-.md file is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      S.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      S.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      S.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!S.templates.has(layout)) {
      S.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      S.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's output directory and url, its slug unique in its directory.
  const taken = new Map();
  const takenIn = (dir) => {
    let t = taken.get(dir);
    if (t === undefined) {
      t = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, t);
    }
    return t;
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, S.slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${S.base}/${s.outDir}/`;
    S.bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  S.staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    S.dir = dirOf(s.path);
    S.curPath = s.path;
    const md = renderMarkdown(s.body, S);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, S.slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, S.slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${S.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name, S.slugCache)) ?? { name, slug: slugify(name, S.slugCache), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(S, p)]));
  S.cards = cards;
  const site = { title: input.site.title, base_url: S.base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates: S.templates, escape: escapeHtml };
  let compiled = null;
  try {
    compiled = compileAll(S.templates);
  } catch {
    compiled = null;
  }
  const render = (name, vars) => {
    if (compiled !== null) {
      const fn = compiled.get(name);
      if (fn === undefined) return null;
      const root = Object.create(null);
      root.site = site;
      root.tags = allTags;
      root.recent = recent;
      Object.assign(root, vars);
      const out = [];
      fn(root, 0, out, COMPILE_HELPERS, compiled);
      return out.join('');
    }
    const nodes = S.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderInto(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(S, s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${S.base}/` : `${S.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) S.report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...S.report, ...S.broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

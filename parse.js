// parse.js — fast Markdown renderer, byte-identical to marked 18.1.3
// (default options, GFM on). Dependency-free ES module.
// Written from scratch by studying marked's *behavior* (black-box probing);
// no marked source was copied. Single-pass index scanner, direct HTML
// emission, no token tree, no caching across calls.

const SP = 32, TAB = 9, NL = 10, CR = 13, FF = 12;

// ---------- character classification ----------
// ASCII punctuation set (CommonMark): !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
         (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCp(cp) {
  if (cp < 128) return isAsciiPunct(cp);
  return PUNCT_RE.test(String.fromCodePoint(cp));
}
// CommonMark whitespace: space, tab, LF, FF, CR, Zs
function isSpaceCp(cp) {
  return cp === 32 || cp === 9 || cp === 10 || cp === 12 || cp === 13 ||
    cp === 0xA0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200A) ||
    cp === 0x202F || cp === 0x205F || cp === 0x3000;
}
function isSpaceCh(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r'; }
// Resolve backslash escapes (backslash + ASCII punctuation -> the char).
// Used for the fence info word (and anywhere a raw string needs unescaping).
function unescapeStr(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else out += s[i];
  }
  return out;
}

// ---------- line / indent helpers ----------
// columns of leading whitespace (tab advances to next multiple of 4)
function indentCols(line) {
  let col = 0, i = 0;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === SP) col++;
    else if (c === TAB) col += 4 - (col & 3);
    else break;
  }
  return col;
}
// strip n columns from the start; a straddling tab leaves spaces
// Expand the leading whitespace run of s into spaces, with tab stops
// computed from starting column `col`. Non-leading content untouched.
function expandTabs(s, col) {
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === SP || s.charCodeAt(i) === TAB)) i++;
  if (i === 0) return s;
  let hasTab = false;
  for (let k = 0; k < i; k++) if (s.charCodeAt(k) === TAB) { hasTab = true; break; }
  if (!hasTab) return s;
  let out = '', c = col;
  for (let k = 0; k < i; k++) {
    if (s.charCodeAt(k) === SP) { out += ' '; c++; }
    else { const w = 4 - (c & 3); out += ' '.repeat(w); c += w; }
  }
  return out + s.slice(i);
}
function stripCols(line, n) {
  if (n <= 0) return line;
  let i = 0, col = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === SP) { i++; col++; }
    else if (c === TAB) {
      const w = 4 - (col & 3);
      // a tab straddling the strip boundary is removed entirely (no
      // leftover spaces) and stripping continues from after it; a tab
      // entirely within the strip is consumed normally. (For fenced
      // code the strip width is the fence indent, 0-3; for indented
      // code it is 4, where a tab never straddles.)
      if (col + w > n) { i++; continue; }
      i++; col += w;
    } else break;
  }
  return line.slice(i);
}
// strip n columns from the start; a straddling tab leaves spaces.
// Unlike stripCols, this counts every character (used for list item lines,
// where the stripped prefix includes the marker, not just whitespace).
function stripNCols(line, n) {
  if (n <= 0) return line;
  let i = 0, col = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === TAB) {
      const w = 4 - (col & 3);
      if (col + w > n) return ' '.repeat(col + w - n) + expandTabs(line.slice(i + 1), col + w);
      i++; col += w;
    } else {
      i++; col++;
    }
  }
  return expandTabs(line.slice(i), col);
}
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== SP && c !== TAB) return false;
  }
  return true;
}

// ---------- escaping ----------
// Decode a numeric character reference at s[i] ('&' + '#' ... ';').
// Returns [codePoint, length] or null. Valid: &#1-7 digits; or
// &#[xX]1-6 hex digits. Value 0, surrogate, or >0x10FFFF -> 0xFFFD.
function numericRef(s, i) {
  // s[i] === '&', s[i+1] === '#'
  let j = i + 2, hex = false;
  if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
  const start = j;
  let val = 0, n = 0;
  if (hex) {
    while (j < s.length) {
      const c = s.charCodeAt(j);
      let d;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (c >= 97 && c <= 102) d = c - 87;
      else if (c >= 65 && c <= 70) d = c - 55;
      else break;
      val = val * 16 + d; n++; j++;
      if (n > 6) return null;
    }
    if (n === 0 || n > 6) return null;
  } else {
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c < 48 || c > 57) break;
      val = val * 10 + (c - 48); n++; j++;
      if (n > 7) return null;
    }
    if (n === 0 || n > 7) return null;
  }
  if (j >= s.length || s.charCodeAt(j) !== 59) return null; // ';'
  if (val === 0 || val > 0x10FFFF || (val >= 0xD800 && val <= 0xDFFF)) val = 0xFFFD;
  return [val, j - i + 1];
}
// Is there an entity-like token at s[i] ('&' + name + ';', any name, or a
// valid numeric ref)? Used by the entity-aware escapers: such tokens pass
// through literally.
function entityAt(s, i) {
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) { // '#'
    const r = numericRef(s, i);
    return r ? r[1] : 0;
  }
  // named: &[A-Za-z][A-Za-z0-9]*;
  if (!((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122))) return 0;
  let j = i + 2;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) j++;
    else break;
  }
  return (j < s.length && s.charCodeAt(j) === 59) ? j - i + 1 : 0;
}

// Entity-aware text escape: & < > " ' -> entities, except that an
// entity-like token (&name; or valid numeric ref) passes through, and a
// valid numeric ref is decoded (then the decoded char is escaped if needed).
const ESC_SPECIAL_RE = /[&<>"']/;
function escText(s) {
  if (!ESC_SPECIAL_RE.test(s)) return s;
  let out = '', start = 0, i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // '&'
      const el = entityAt(s, i);
      if (el > 0) {
        if (s.charCodeAt(i + 1) === 35) { // numeric: decode + escape char
          const r = numericRef(s, i);
          const ch = String.fromCodePoint(r[0]);
          out += s.slice(start, i);
          out += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;'
               : ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch;
          i += r[1]; start = i;
        } else {
          i += el; // named entity: pass through
        }
      } else {
        out += s.slice(start, i) + '&amp;';
        i++; start = i;
      }
    } else if (c === 60) { out += s.slice(start, i) + '&lt;'; i++; start = i; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; i++; start = i; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; i++; start = i; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; i++; start = i; }
    else i++;
  }
  return start === 0 ? s : out + s.slice(start);
}
// Non-entity-aware escape (code spans/blocks, autolink text/href):
// every & < > " ' is escaped.
function escCode(s) {
  let out = '', start = 0, i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += s.slice(start, i) + '&amp;'; i++; start = i; }
    else if (c === 60) { out += s.slice(start, i) + '&lt;'; i++; start = i; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; i++; start = i; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; i++; start = i; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; i++; start = i; }
    else i++;
  }
  return start === 0 ? s : out + s.slice(start);
}
// Escape a single character (for backslash-resolved punctuation / decoded
// numeric chars): & < > " ' -> entity, everything else as-is.
function escChar(ch) {
  return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;'
       : ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch;
}

// ---------- URLs ----------
// encodeURI semantics, but safe for lone surrogates (encodeURI throws).
function encodeUrl(dest) {
  // encodeURI semantics, except '%' is left raw (marked never encodes it,
  // even %zz / %2G). encodeURI turns '%' into %25, so undo that.
  try { return encodeURI(dest).replace(/%25/g, '%'); }
  catch (e) {
    // manual fallback: percent-encode everything encodeURI would, with
    // lone surrogates replaced by U+FFFD
    let out = '';
    for (let i = 0; i < dest.length; i++) {
      const cp = dest.codePointAt(i);
      if (cp > 0xFFFF) i++;
      const ch = String.fromCodePoint(cp >= 0xD800 && cp <= 0xDFFF ? 0xFFFD : cp);
      if (/^[A-Za-z0-9;,/?:@&=+$-_.!~*'()#%]$/.test(ch)) out += ch;
      else {
        const bytes = new TextEncoder().encode(ch);
        for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    }
    return out;
  }
}
// href/src attribute value: encodeURI, then entity-aware & + ' escaping.
function escHref(dest) {
  const enc = encodeUrl(dest);
  let out = '', start = 0, i = 0;
  const n = enc.length;
  while (i < n) {
    const c = enc.charCodeAt(i);
    if (c === 38) {
      const el = entityAt(enc, i);
      if (el > 0) i += el;
      else { out += enc.slice(start, i) + '&amp;'; i++; start = i; }
    } else if (c === 39) { out += enc.slice(start, i) + '&#39;'; i++; start = i; }
    else i++;
  }
  return start === 0 ? enc : out + enc.slice(start);
}
// Autolink href: encodeURI, then NON-entity-aware & + ' escaping.
function escAutoHref(dest) {
  const enc = encodeUrl(dest);
  let out = '', start = 0, i = 0;
  const n = enc.length;
  while (i < n) {
    const c = enc.charCodeAt(i);
    if (c === 38) { out += enc.slice(start, i) + '&amp;'; i++; start = i; }
    else if (c === 39) { out += enc.slice(start, i) + '&#39;'; i++; start = i; }
    else i++;
  }
  return start === 0 ? enc : out + enc.slice(start);
}

// ---------- reference labels ----------
// Normalize a raw label: collapse [ \t\n]+ to one space, trim, then
// toLowerCase().toUpperCase() (equates I/i/ı, ß/SS, ﬀ/FF, K/K, ...).
function normLabel(raw) {
  return raw.replace(/[ \t\n]+/g, ' ').trim().toLowerCase().toUpperCase();
}

// ---------- inline parsing ----------
// Node types
const T_TEXT = 0, T_CODE = 1, T_HTML = 2, T_BR = 3, T_SOFT = 4,
      T_DELIM = 5, T_BRACKET = 6, T_LINK = 7, T_IMAGE = 8,
      T_EM = 9, T_STRONG = 10, T_DEL = 11, T_AUTO = 12;

// Fast-path test: no inline construct and no hard break.
// Split so the hot regex stays case-sensitive (the `i` flag slows the
// whole alternation down): www. is lowercase-only, and http(s):// in any
// case is caught by the second, simpler test.
const INLINE_SPECIAL_RE = /[*_~[\]!<&`\\]| {2,}\n|www\.|https?:\/\/|@/;
const INLINE_HTTP_RE = /https?:\/\//i;
// Next potentially-special char for the inline loop's plain-run jump:
// any char the loop dispatches on (backslash, backtick, * _ ~, brackets,
// !, <, &, newline, w/h for www/http, @). A global regex so the native
// scanner can skip a whole plain run at once.
const NEXT_SPECIAL_RE = /[\\`*_~\[!\]<&\nwhH@]/g;

// Email (bare / extended autolink): local@domain with >=1 dot in domain.
// Sticky: match must start at lastIndex.
const EMAIL_STICKY = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?)+/y;
// Email inside <...>: domain may have zero dots.
const EMAIL_ANGLE_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
// Scheme autolink <scheme:...>: scheme 2-32 chars, rest has no space/<.
const SCHEME_ANGLE_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^ \t\n<>]*$/;

function isEmailLocalChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
    c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
    c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 ||
    c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 ||
    c === 126 || c === 45;
}
// A character that may appear in a URI scheme after the first letter.
function isSchemeChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
    c === 43 || c === 45 || c === 46;
}

// code point of the char before index i in text (or outerPrev if i==0)
function cpBefore(text, i, outerPrev) {
  if (i > 0) {
    const c = text.charCodeAt(i - 1);
    if (c >= 0xDC00 && c <= 0xDFFF && i >= 2) {
      const hi = text.charCodeAt(i - 2);
      if (hi >= 0xD800 && hi <= 0xDBFF) return (hi - 0xD800) * 0x400 + (c - 0xDC00) + 0x10000;
    }
    return c;
  }
  return outerPrev === null ? -1 : outerPrev.codePointAt(0);
}
function cpAfter(text, j, outerNext) {
  if (j < text.length) return text.codePointAt(j);
  return outerNext === null ? -1 : outerNext.codePointAt(0);
}

// Flanking for a delimiter run: [leftFlanking, rightFlanking].
// Boundary (-1) counts as whitespace, not punctuation.
function flanking(prevCp, nextCp) {
  const prevWs = prevCp < 0 || isSpaceCp(prevCp);
  const prevPunct = prevCp >= 0 && isPunctCp(prevCp);
  const nextWs = nextCp < 0 || isSpaceCp(nextCp);
  const nextPunct = nextCp >= 0 && isPunctCp(nextCp);
  return [!nextWs && (!nextPunct || prevWs || prevPunct),
          !prevWs && (!prevPunct || nextWs || nextPunct)];
}

// Skip spaces/tabs/newlines.
function skipWs(text, i) {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 12 || c === 13) i++;
    else break;
  }
  return i;
}

// Parse a link title at text[i] ('"', "'", or '('). Returns {title, end}
// or null. Title may contain newlines but no blank line.
function parseTitle(text, i) {
  const open = text.charCodeAt(i);
  const close = open === 40 ? 41 : open;
  let j = i + 1, title = '';
  const n = text.length;
  while (j < n) {
    const cc = text.charCodeAt(j);
    if (cc === 92) {
      const nc = j + 1 < n ? text.charCodeAt(j + 1) : -1;
      if (nc >= 0 && isAsciiPunct(nc)) { title += text[j + 1]; j += 2; }
      else { title += '\\'; j++; }
    } else if (cc === close) {
      return { title, end: j + 1 };
    } else if (cc === 10) {
      // blank line inside title is not allowed
      let k = j + 1;
      while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
      if (k >= n || text.charCodeAt(k) === 10) return null;
      title += '\n'; j++;
    } else {
      title += text[j]; j++;
    }
  }
  return null;
}

// Parse an inline link "(...)" starting at text[j] === '('.
// Returns {href, title, end} (end = index just after ')') or null.
function parseInlineLink(text, j) {
  const n = text.length;
  let i = skipWs(text, j + 1);
  if (i >= n) return null;
  let href;
  if (text.charCodeAt(i) === 60) { // '<' angle dest
    let k = i + 1, dest = '', closed = false;
    while (k < n) {
      const cc = text.charCodeAt(k);
      if (cc === 92) {
        const nc = k + 1 < n ? text.charCodeAt(k + 1) : -1;
        if (nc >= 0 && isAsciiPunct(nc)) { dest += text[k + 1]; k += 2; }
        else { dest += '\\'; k++; }
      } else if (cc === 62) { closed = true; k++; break; }
      else if (cc === 10) return null;
      else { dest += text[k]; k++; }
    }
    if (!closed) return null;
    href = dest;
    i = k;
  } else {
    // bare dest: balanced parens, escapes; ends at ws/control/')' (depth 0)
    let k = i, depth = 0, dest = '';
    while (k < n) {
      const cc = text.charCodeAt(k);
      if (cc === 92) {
        const nc = k + 1 < n ? text.charCodeAt(k + 1) : -1;
        if (nc >= 0 && isAsciiPunct(nc)) { dest += text[k + 1]; k += 2; }
        else { dest += '\\'; k++; }
      } else if (cc === 40) { depth++; dest += '('; k++; }
      else if (cc === 41) {
        if (depth === 0) break;
        depth--; dest += ')'; k++;
      } else if (cc === 32 || cc === 9 || cc === 10 || cc < 32) {
        break;
      } else { dest += text[k]; k++; }
    }
    if (depth > 0) return null;
    href = dest;
    i = k;
  }
  // optional ws, optional title, optional ws, then ')'
  // (a title must be separated from the dest by whitespace)
  const destEnd = i;
  i = skipWs(text, i);
  let title = null;
  if (i < n && i > destEnd) {
    const tc = text.charCodeAt(i);
    if (tc === 34 || tc === 39 || tc === 40) {
      const t = parseTitle(text, i);
      if (t) { title = t.title; i = skipWs(text, t.end); }
    }
  }
  if (i >= n || text.charCodeAt(i) !== 41) return null;
  return { href, title, end: i + 1 };
}

// Try a reference link at text[j] (index just after the link text's ']').
// labelRaw = raw link-text substring (for collapsed/shortcut).
// Returns {href, title, end} or null. No fallback to shortcut after a
// failed full reference.
function tryRef(text, j, labelRaw, refs) {
  const n = text.length;
  if (j < n && text.charCodeAt(j) === 91) { // '['
    // full reference: scan for the label's closing ']'
    // (a label may not contain an unescaped '[')
    let k = j + 1, labelEnd = -1;
    while (k < n) {
      const cc = text.charCodeAt(k);
      if (cc === 92) { k += 2; continue; }
      if (cc === 91) break; // '[' not allowed in a label
      if (cc === 93) { labelEnd = k; break; }
      k++;
    }
    if (labelEnd > 0) {
      const def = refs.get(normLabel(text.slice(j + 1, labelEnd)));
      if (def) return { href: def.href, title: def.title, end: labelEnd + 1 };
    }
    // collapsed "[foo][]"
    if (j + 1 < n && text.charCodeAt(j + 1) === 93) {
      const def = refs.get(normLabel(labelRaw));
      if (def) return { href: def.href, title: def.title, end: j + 2 };
    }
    return null;
  }
  // shortcut
  const def = refs.get(normLabel(labelRaw));
  if (def) return { href: def.href, title: def.title, end: j };
  return null;
}

// Parse an HTML tag / comment / PI / declaration / CDATA at text[i] === '<'.
// Returns {text, end} or null.
function parseHtmlTag(text, i) {
  const n = text.length;
  // comment <!-- ... --> (search from i+2 so <!--> and <!---> close)
  if (text.startsWith('<!--', i)) {
    const end = text.indexOf('-->', i + 2);
    if (end < 0) return null;
    return { text: text.slice(i, end + 3), end: end + 3 };
  }
  // CDATA <![CDATA[ ... ]]> (before the <! declaration check, which
  // would reject '[')
  if (text.startsWith('<![CDATA[', i)) {
    const end = text.indexOf(']]>', i + 9);
    if (end < 0) return null;
    return { text: text.slice(i, end + 3), end: end + 3 };
  }
  // processing instruction <? ... ?>
  if (text.startsWith('<?', i)) {
    const end = text.indexOf('?>', i + 2);
    if (end < 0) return null;
    return { text: text.slice(i, end + 2), end: end + 2 };
  }
  // declaration <!X ... > (X = letter or !)
  if (text.startsWith('<!', i)) {
    const c2 = i + 2 < n ? text.charCodeAt(i + 2) : -1;
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122) || c2 === 33) {
      const end = text.indexOf('>', i + 2);
      if (end < 0) return null;
      return { text: text.slice(i, end + 1), end: end + 1 };
    }
    return null;
  }
  // open/close tag
  let j = i + 1;
  let isClose = false;
  if (j < n && text.charCodeAt(j) === 47) { j++; isClose = true; } // '/'
  // tag name: [A-Za-z][A-Za-z0-9-]*
  if (j >= n) return null;
  const c0 = text.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return null;
  const nameStart = j;
  j++;
  while (j < n) {
    const cc = text.charCodeAt(j);
    if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 45) j++;
    else break;
  }
  const tagName = text.slice(nameStart, j).toLowerCase();
  if (isClose) {
    // a closing tag has no attributes: only whitespace, then '>'
    while (j < n) {
      const cc = text.charCodeAt(j);
      if (cc === 32 || cc === 9 || cc === 10 || cc === 12 || cc === 13) j++;
      else break;
    }
    if (j < n && text.charCodeAt(j) === 62) return { text: text.slice(i, j + 1), end: j + 1, tagName, isClose, hasHref: false };
    return null;
  }
  // attributes (each must be preceded by whitespace)
  let hasHref = false;
  while (true) {
    const wsStart = j;
    // skip whitespace
    while (j < n) {
      const cc = text.charCodeAt(j);
      if (cc === 32 || cc === 9 || cc === 10 || cc === 12 || cc === 13) j++;
      else break;
    }
    if (j >= n) return null;
    const cc = text.charCodeAt(j);
    if (cc === 62) return { text: text.slice(i, j + 1), end: j + 1, tagName, isClose, hasHref }; // '>'
    if (cc === 47) { // '/'
      if (j + 1 < n && text.charCodeAt(j + 1) === 62) return { text: text.slice(i, j + 2), end: j + 2, tagName, isClose, hasHref };
      return null;
    }
    // no whitespace before this attribute -> not a tag
    if (j === wsStart) return null;
    // attribute name: [A-Za-z_:][A-Za-z0-9_.:-]*
    if (!((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 95 || cc === 58)) return null;
    const attrStart = j;
    j++;
    while (j < n) {
      const ac = text.charCodeAt(j);
      if ((ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || (ac >= 48 && ac <= 57) ||
          ac === 95 || ac === 58 || ac === 46 || ac === 45) j++;
      else break;
    }
    if (text.slice(attrStart, j).toLowerCase() === 'href') hasHref = true;
    // optional whitespace, optional = value
    const afterName = j;
    while (j < n) {
      const wc = text.charCodeAt(j);
      if (wc === 32 || wc === 9 || wc === 10 || wc === 12 || wc === 13) j++;
      else break;
    }
    if (j < n && text.charCodeAt(j) === 61) { // '='
      j++;
      while (j < n) {
        const wc = text.charCodeAt(j);
        if (wc === 32 || wc === 9 || wc === 10 || wc === 12 || wc === 13) j++;
        else break;
      }
      if (j >= n) return null;
      const vc = text.charCodeAt(j);
      if (vc === 34 || vc === 39) { // quoted value
        const q = vc;
        j++;
        while (j < n && text.charCodeAt(j) !== q) j++;
        if (j >= n) return null;
        j++; // closing quote
      } else { // unquoted value
        let vl = 0;
        while (j < n) {
          const uc = text.charCodeAt(j);
          if (uc === 32 || uc === 9 || uc === 10 || uc === 12 || uc === 13 ||
              uc === 34 || uc === 39 || uc === 61 || uc === 60 || uc === 62 || uc === 96) break;
          j++; vl++;
        }
        if (vl === 0) return null;
      }
    } else {
      // no value: the whitespace belongs to the next attribute / '>' / '/'
      j = afterName;
    }
  }
}

// ---------- extended autolinks (www / http) ----------
// Trailing punctuation trimmed from a URL run.
function isUrlTrailPunct(c) {
  return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
         c === 42 || c === 95 || c === 126;
}
// Scan a URL run starting at text[start] (the 'w' of www. or 'h' of http).
// The run continues until whitespace or '<'. Returns {url, end} (end = index
// just after the trimmed URL) or null if nothing usable.
// Is the ']' at text[p] a link closer? True if followed by '(' (inline
// link dest) or by '[label]' where the label resolves to a refdef.
// a ']' followed by '(' or by a resolving '[label]' looks like a link
// closer, whether or not the link can actually form
function looksLikeCloser(text, p, refs) {
  const n = text.length;
  if (p + 1 >= n) return false;
  const nx = text.charCodeAt(p + 1);
  if (nx === 40) return true; // '(' — inline link dest follows
  if (nx === 91 && refs) { // '[' — full reference?
    let k = p + 2, labelEnd = -1;
    while (k < n) {
      const cc = text.charCodeAt(k);
      if (cc === 92) { k += 2; continue; }
      if (cc === 91) break;
      if (cc === 93) { labelEnd = k; break; }
      k++;
    }
    if (labelEnd > 0 && refs.get(normLabel(text.slice(p + 2, labelEnd)))) return true;
  }
  return false;
}

function isLinkCloser(text, p, refs, nodes) {
  if (!looksLikeCloser(text, p, refs)) return false;
  // a real closer only if an open bracket exists for the ']' to close
  // and that bracket's link can form (no nested link inside it)
  if (nodes) {
    for (let k = nodes.length - 1; k >= 0; k--) {
      if (nodes[k].t === T_BRACKET && nodes[k].active) {
        for (let m = k + 1; m < nodes.length; m++) {
          if (nodes[m].t === T_LINK) return false;
        }
        return true;
      }
    }
  }
  return false;
}

function scanUrlRun(text, start, refs, nodes) {
  const n = text.length;
  let end = start;
  while (end < n) {
    const cc = text.charCodeAt(end);
    if (cc === 32 || cc === 9 || cc === 10 || cc === 12 || cc === 13 || cc === 60) break;
    // a ']' that actually closes a link ends the URL run (the link
    // resolves first); a ']' that only LOOKS like a closer (followed
    // by '(' or a resolving label) but whose link fails — or with no
    // open bracket at all — is included in the URL; if followed by
    // '(' the run then continues only through a clean (...) group
    // (balanced, no whitespace) — a group with whitespace stops the
    // run right after the ']'; any other ']' stays part of the URL
    if (cc === 93) {
      if (isLinkCloser(text, end, refs, nodes)) break;
      if (looksLikeCloser(text, end, refs)) {
        end++; // include the ']'
        if (end < n && text.charCodeAt(end) === 40) {
          // scan the (...) group for a matching ')' with no whitespace
          let depth = 0, k = end, ok = false;
          while (k < n) {
            const c2 = text.charCodeAt(k);
            if (c2 === 32 || c2 === 9 || c2 === 10 || c2 === 12 || c2 === 13 || c2 === 60) break;
            if (c2 === 40) depth++;
            else if (c2 === 41) { depth--; if (depth === 0) { ok = true; k++; break; } }
            k++;
          }
          if (ok) { end = k; continue; }
          break; // group has whitespace / no match: stop after ']'
        }
        // followed by '[label]': '[' is an ordinary URL char, keep going
      }
    }
    end++;
  }
  if (end === start) return null;
  let url = text.slice(start, end);
  // trim a trailing entity-like suffix (&name; / numeric ref)
  const amp = url.lastIndexOf('&');
  if (amp >= 0) {
    const el = entityAt(url, amp);
    if (el > 0 && amp + el === url.length) url = url.slice(0, amp);
  }
  // trim trailing punctuation and unmatched trailing ')', alternating
  // until stable (a ')' may hide punctuation behind it, and vice
  // versa). a trailing ')' is unmatched only if no '(' before it in
  // the URL is still open (stack scan, stray ')' ignored) — e.g.
  // 'a)](b)' keeps its final ')' but 'a(b))' loses one
  let changed = true;
  while (changed) {
    changed = false;
    while (url.length > 0 && isUrlTrailPunct(url.charCodeAt(url.length - 1))) {
      url = url.slice(0, -1);
      changed = true;
    }
    while (url.length > 0 && url.charCodeAt(url.length - 1) === 41) {
      let depth = 0;
      for (let k = 0; k < url.length - 1; k++) {
        const cc = url.charCodeAt(k);
        if (cc === 40) depth++;
        else if (cc === 41 && depth > 0) depth--;
      }
      if (depth > 0) break; // trailing ')' is matched by an open '('
      url = url.slice(0, -1);
      changed = true;
    }
  }
  if (url.length === 0) return null;
  return { url, end: start + url.length };
}

// Preceding-char rule for www.: allowed if at the start of the current text
// run (right after a non-text token) or the raw preceding char is whitespace
// or one of * _ ~ (.
function wwwPrecedingOk(text, i, runStart) {
  if (i === runStart) return true;
  const c = text.charCodeAt(i - 1);
  if (c === 42 || c === 95 || c === 126 || c === 40) return true;
  if (c === 32 || c === 9 || c === 10 || c === 12 || c === 13) return true;
  if (c >= 128) {
    const cp = cpBefore(text, i, null);
    return isSpaceCp(cp);
  }
  return false;
}

// ---------- emphasis processing ----------
// Process delimiter nodes in `nodes` (and recursively in link children).
// Wraps matched ranges into em/strong/del nodes.
function processEmphasis(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t === T_LINK || nd.t === T_IMAGE) processEmphasis(nd.children);
  }
  let i = 0;
  while (i < nodes.length) {
    const nd = nodes[i];
    if (nd.t !== T_DELIM || nd.len <= 0 || !nd.canClose) { i++; continue; }
    const closer = nd;
    // find the nearest matching opener (ghosts — len-0 delimiters left
    // by an inner emphasis — are skipped here; they are checked for
    // blocking below, once the opener is known). a 'dead' opener
    // (blocked by a ghost for an earlier closer) is skipped too.
    let oj = -1, opener = null;
    for (let j = i - 1; j >= 0; j--) {
      const o = nodes[j];
      if (o.t !== T_DELIM || o.ch !== closer.ch || o.len <= 0 || !o.canOpen || o.dead) continue;
      if (closer.ch === '~') {
        if (o.len !== closer.len) continue; // ~ needs equal lengths
      } else {
        const oBoth = o.canOpen && o.canClose, cBoth = closer.canOpen && closer.canClose;
        if ((oBoth || cBoth) && (o.len + closer.len) % 3 === 0 &&
            (o.len % 3 !== 0 || closer.len % 3 !== 0)) continue; // odd match
      }
      oj = j; opener = o; break;
    }
    if (oj < 0) { i++; continue; }
    // ghost block: a both-flanking delimiter fully consumed by an
    // inner emphasis, sitting between opener and closer, can block
    // this match (marked quirk). blocking rule, fitted to marked on
    // the (opener, ghost, closer) length grid: a closer whose length
    // is a multiple of 3 is never blocked; a len-1 closer is blocked
    // unless opener len 1 and ghost len odd; a len-2 closer is
    // blocked unless opener len <= 2 and (opener+ghost) % 3 != 0.
    // a ghost blocks at most once (it is spent afterwards).
    let blocked = false;
    if (closer.ch !== '~') {
      for (let k = i - 1; k > oj; k--) {
        const g = nodes[k];
        // only a ghost that was a CLOSER (pairedOpenerBoth is set) can
        // block, and only when its inner opener was NOT both-flanking
        if (g.t !== T_DELIM || g.ch !== closer.ch || g.len !== 0 ||
            !g.canOpen || !g.canClose || g.spent ||
            g.pairedOpenerBoth === undefined || g.pairedOpenerBoth) continue;
        const O = opener.len, G = g.olen, C = closer.len;
        let blocks = true;
        if (C % 3 === 0) blocks = false;
        else if (C === 1 && O === 1 && (G % 2 === 1)) blocks = false;
        else if (C === 2 && O <= 2 && ((O + G) % 3 !== 0)) blocks = false;
        if (blocks) { g.spent = true; blocked = true; break; }
      }
    }
    if (blocked) {
      // the opener this closer was blocked from is dead for later
      // closers too — but only when an earlier opener of the same
      // char exists (the outermost opener stays matchable, e.g. D1
      // in '*a **b**c*d*e*f*' is still matched by a later closer)
      let earlier = false;
      for (let k = oj - 1; k >= 0; k--) {
        const e = nodes[k];
        if (e.t === T_DELIM && e.ch === closer.ch && e.len > 0 && e.canOpen && !e.dead) { earlier = true; break; }
      }
      if (earlier) opener.dead = true;
      i++; continue;
    }
    const use = closer.ch === '~' ? closer.len
      : (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
    const kind = closer.ch === '~' ? T_DEL : (use === 2 ? T_STRONG : T_EM);
    const wrap = { t: kind, children: nodes.slice(oj + 1, i) };
    const openerPreLen = opener.len;
    opener.len -= use;
    closer.len -= use;
    // remember whether the opener this closer just matched was
    // both-flanking: a ghost only blocks a later outer match when its
    // inner emphasis was opened by a NON-both opener (e.g. '*a **b**c*'
    // blocks, but intraword '*foo**bar**baz*' and '**a *b*c*'-style
    // cases with a both opener do not)
    closer.pairedOpenerBoth = opener.canOpen && opener.canClose;
    // leftover closer position (marked quirk): when the opener is fully
    // consumed and the closer still has delimiters, they render INSIDE
    // the emphasis only when the opener was fresh (not already partly
    // consumed by this same closer, e.g. 'foo******bar*********baz'),
    // no earlier live opener of the same char exists before it (the
    // leftover may still pair with it, e.g. '*foo **bar**baz*'), and
    // either the match used 2 with a pre-existing inner emphasis wrap
    // between opener and closer ('**a *b*c***', '**foo***' stays out
    // because it has none), or it used 1 with an inner strong ghost
    // (olen >= 2) between them ('*a **b**c***' in, '*a *b*c***' out);
    // otherwise the leftover stays after the wrap, still matchable
    // (e.g. '***foo***' needs it to form the outer em)
    if (closer.len > 0 && opener.len === 0 && closer.ch !== '~') {
      let earlier = false;
      for (let k = oj - 1; k >= 0; k--) {
        const e = nodes[k];
        if (e.t === T_DELIM && e.ch === closer.ch && e.len > 0 && e.canOpen && !e.dead) { earlier = true; break; }
      }
      const openerFresh = openerPreLen === opener.olen;
      let moveInside = false;
      if (!earlier && openerFresh) {
        if (use === 2) {
          for (let k = oj + 1; k < i; k++) {
            const w = nodes[k];
            if (w.t === T_EM || w.t === T_STRONG || w.t === T_DEL) { moveInside = true; break; }
          }
        } else {
          for (let k = oj + 1; k < i; k++) {
            const g = nodes[k];
            if (g.t === T_DELIM && g.ch === closer.ch && g.len === 0 && g.olen >= 2) { moveInside = true; break; }
          }
        }
      }
      if (moveInside) {
        const leftover = closer.ch.repeat(closer.len);
        wrap.children.push({ t: T_TEXT, s: leftover, h: escText(leftover) });
        closer.len = 0;
        closer.pairedOpenerBoth = undefined;
      }
    }
    // a fully consumed delimiter stays in the list as a len-0 ghost
    // (it still blocks later closers via the odd-match rule above)
    const seg = [opener, wrap, closer];
    nodes.splice(oj, i - oj + 1, ...seg);
    // continue at the closer (if it still has length) or after the wrap
    i = closer.len > 0 ? oj + seg.length - 1 : oj + seg.length;
  }
}

// ---------- rendering inline nodes ----------
// Plain text of a node list (for image alt text and link labels).
function plainText(nodes) {
  let out = '';
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    switch (nd.t) {
      case T_TEXT: out += nd.s; break;
      case T_CODE: out += nd.s; break;
      case T_HTML: out += nd.s; break;
      case T_BR: break; // hard break -> empty
      case T_SOFT: out += '\n'; break;
      case T_DELIM: out += nd.ch.repeat(nd.len); break;
      case T_BRACKET: out += nd.isImage ? '![' : '['; break;
      case T_LINK: out += plainText(nd.children); break;
      case T_IMAGE: out += plainText(nd.children); break;
      case T_EM: case T_STRONG: case T_DEL: out += plainText(nd.children); break;
      case T_AUTO: out += nd.text; break;
    }
  }
  return out;
}

function renderNodes(nodes) {
  let out = '';
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    switch (nd.t) {
      case T_TEXT: out += nd.h; break;
      case T_CODE: out += '<code>' + escCode(nd.s) + '</code>'; break;
      case T_HTML: out += nd.s; break;
      case T_BR: out += '<br>'; break;
      case T_SOFT: out += '\n'; break;
      case T_DELIM: out += nd.ch.repeat(nd.len); break;
      case T_BRACKET: out += nd.isImage ? '![' : '['; break;
      case T_LINK: {
        out += '<a href="' + escHref(nd.href) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escText(nd.title) + '"';
        out += '>' + renderNodes(nd.children) + '</a>';
        break;
      }
      case T_IMAGE: {
        out += '<img src="' + escHref(nd.src) + '" alt="' + escText(plainText(nd.children)) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escText(nd.title) + '"';
        out += '>';
        break;
      }
      case T_EM: out += '<em>' + renderNodes(nd.children) + '</em>'; break;
      case T_STRONG: out += '<strong>' + renderNodes(nd.children) + '</strong>'; break;
      case T_DEL: out += '<del>' + renderNodes(nd.children) + '</del>'; break;
      case T_AUTO: {
        out += '<a href="' + escAutoHref(nd.href) + '">' + escCode(nd.text) + '</a>';
        break;
      }
    }
  }
  return out;
}

// ---------- main inline parser ----------
// Parse inline content of a block (paragraph, heading, table cell).
// refs: Map of normalized label -> {href, title}.
// Returns the HTML string.
function parseInline(text, refs) {
  if (!INLINE_SPECIAL_RE.test(text) && !INLINE_HTTP_RE.test(text)) return escText(text);
  const nodes = [];
  const n = text.length;
  let curS = '', curH = '';
  let runStart = 0;
  let pendingBrackets = 0;
  // phantom-code-span suppression intervals [start, end): an unmatched
  // backtick run inside a link's text that finds a same-length closer
  // after the link suppresses emphasis between the link end and it
  const suppress = [];
  const flush = () => {
    if (curS !== '' || curH !== '') {
      nodes.push({ t: T_TEXT, s: curS, h: curH });
      curS = ''; curH = '';
    }
  };
  const addSlice = (a, b) => {
    if (b > a) {
      const s = text.slice(a, b);
      curS += s;
      curH += escText(s);
    }
  };

  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92) { // backslash
      const nc = i + 1 < n ? text.charCodeAt(i + 1) : -1;
      if (nc === 10) {
        addSlice(runStart, i); flush();
        nodes.push({ t: T_BR });
        i += 2;
        // after a hard break, the next line's leading whitespace is stripped
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        runStart = i;
      } else if (nc >= 0 && isAsciiPunct(nc)) {
        addSlice(runStart, i);
        const ch = text[i + 1];
        curS += ch; curH += escChar(ch);
        i += 2; runStart = i;
      } else {
        i++;
      }
    } else if (c === 96) { // backtick
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      const runLen = j - i;
      // bracket-aware closer search (marked quirk): the FIRST backtick
      // run inside a bracket may pair with a same-length closer across
      // the ']' (forming a code span that swallows it and breaks the
      // link); a LATER run in the same bracket may only pair within
      // the link text. An unmatched first run dooms the link unless a
      // later run appears in the bracket or it sits right before ']'.
      let br = null;
      if (pendingBrackets > 0) {
        for (let k = nodes.length - 1; k >= 0; k--) {
          if (nodes[k].t === T_BRACKET && nodes[k].active) { br = nodes[k]; break; }
        }
      }
      const firstRun = br && !br.btSeen;
      if (br) {
        if (firstRun) br.btSeen = true;
        else br.btRescue = true;
      }
      let k = j, closer = -1, closerEnd = -1, sawBt = false, crossed = false;
      while (k < n) {
        if (text.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && text.charCodeAt(m) === 96) m++;
          if (m - k === runLen) { closer = k; closerEnd = m; break; }
          // a different-length run: note it only if before any ']'
          if (!crossed) sawBt = true;
          k = m;
        } else if (text.charCodeAt(k) === 93) {
          if (!firstRun && br) break; // non-first run: bounded by ']'
          if (br && firstRun && sawBt) break; // first run: a run before
          // ']' bounds the search (only same-length runs before it count)
          crossed = true;
          k++;
        } else k++;
      }
      if (closer < 0) {
        if (br && firstRun) { br.btFirstUnmatched = true; br.btFirstEnd = j; }
        if (br) { (br.unmatched = br.unmatched || []).push(runLen); }
        i = j;
      } else {
        addSlice(runStart, i); flush();
        let content = text.slice(j, closer).replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 &&
            content.charCodeAt(content.length - 1) === 32 && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        nodes.push({ t: T_CODE, s: content });
        i = closerEnd; runStart = i;
      }
    } else if (c === 42 || c === 95 || c === 126) { // * _ ~
      const ch = text[i];
      let j = i;
      while (j < n && text.charCodeAt(j) === c) j++;
      const runLen = j - i;
      if (c === 126 && runLen > 2) {
        i = j;
      } else {
        const prevCp = cpBefore(text, i, null);
        const nextCp = cpAfter(text, j, null);
        const fl = flanking(prevCp, nextCp);
        const left = fl[0], right = fl[1];
        let canOpen, canClose;
        if (ch === '_') {
          canOpen = left && (!right || (prevCp >= 0 && isPunctCp(prevCp)));
          canClose = right && (!left || (nextCp >= 0 && isPunctCp(nextCp)));
        } else {
          canOpen = left; canClose = right;
        }
        // inside a phantom code span (see suppress): not a delimiter.
        // Only at the top level -- delimiters inside a link/image's
        // text are parsed in their own scope and are not suppressed.
        let suppressed = false;
        if (suppress.length > 0 && pendingBrackets === 0) {
          for (let s = 0; s < suppress.length; s++) {
            if (i >= suppress[s][0] && i < suppress[s][1]) { suppressed = true; break; }
          }
        }
        if ((!canOpen && !canClose) || suppressed) {
          // dead delimiter: it can never form emphasis, so leave it in
          // the text run (this also lets email autolinks see through it)
          i = j;
        } else {
          addSlice(runStart, i); flush();
          nodes.push({ t: T_DELIM, ch, len: runLen, olen: runLen, canOpen, canClose });
          i = j; runStart = i;
        }
      }
    } else if (c === 91) { // '['
      addSlice(runStart, i); flush();
      nodes.push({ t: T_BRACKET, pos: i, isImage: false, active: true });
      pendingBrackets++;
      i++; runStart = i;
    } else if (c === 33) { // '!'
      if (i + 1 < n && text.charCodeAt(i + 1) === 91) {
        addSlice(runStart, i); flush();
        nodes.push({ t: T_BRACKET, pos: i + 1, isImage: true, active: true });
        pendingBrackets++;
        i += 2; runStart = i;
      } else {
        i++;
      }
    } else if (c === 93) { // ']'
      let bi = -1;
      for (let k = nodes.length - 1; k >= 0; k--) {
        if (nodes[k].t === T_BRACKET && nodes[k].active) { bi = k; break; }
      }
      if (bi < 0) { i++; continue; }
      const bracket = nodes[bi];
      // a bracket whose FIRST backtick run never found a same-length
      // closer is doomed (no link forms) unless a later backtick run
      // appeared inside it or the run sits right before this ']'
      if (bracket.btFirstUnmatched && !bracket.btRescue && bracket.btFirstEnd !== i) {
        bracket.active = false;
        pendingBrackets--;
        i++;
        continue;
      }
      const labelRaw = text.slice(bracket.pos + 1, i);
      let link = null, endPos = i;
      if (i + 1 < n && text.charCodeAt(i + 1) === 40) {
        const il = parseInlineLink(text, i + 1);
        if (il) { link = il; endPos = il.end; }
      }
      if (!link) {
        const ref = tryRef(text, i + 1, labelRaw, refs);
        if (ref) { link = ref; endPos = ref.end; }
      }
      if (link && !bracket.isImage) {
        // a link's text may not contain a link node
        for (let k = bi + 1; k < nodes.length; k++) {
          if (nodes[k].t === T_LINK) { link = null; break; }
        }
      }
      if (link) {
        // marked quirk: a code span whose content contains a backtick
        // (multi-backtick span) inside link/image text blocks the
        // link unless the span is the last element before ']'; when
        // blocked, the emphasis delimiters in the link text also go
        // dead (top level only -- delimiters inside a nested link's
        // children still work)
        const tail = text.slice(runStart, i);
        for (let k = bi + 1; k < nodes.length; k++) {
          if (nodes[k].t === T_CODE && nodes[k].s.indexOf('`') >= 0) {
            if (k < nodes.length - 1 || tail.length > 0) {
              link = null;
              for (let m = bi + 1; m < nodes.length; m++) {
                if (nodes[m].t === T_DELIM) { nodes[m].canOpen = false; nodes[m].canClose = false; }
              }
              break;
            }
          }
        }
      }
      if (link) {
        // phantom code span: an unmatched backtick run inside the link
        // text that finds a same-length closer after the link suppresses
        // emphasis between the link end and that closer (one interval
        // per pairing run; the union applies)
        if (bracket.unmatched) {
          for (const L of bracket.unmatched) {
            let p = endPos;
            while (p < n) {
              if (text.charCodeAt(p) === 96) {
                let q = p;
                while (q < n && text.charCodeAt(q) === 96) q++;
                if (q - p === L) { suppress.push([endPos, p]); break; }
                p = q;
              } else p++;
            }
          }
        }
        addSlice(runStart, i); flush();
        const children = nodes.splice(bi + 1);
        // extended autolinks are suppressed inside a link that forms:
        // turn them back into plain text (angle autolinks stay links)
        for (let k = 0; k < children.length; k++) {
          if (children[k].t === T_AUTO && children[k].ext) {
            children[k] = { t: T_TEXT, s: children[k].text, h: escText(children[k].text) };
          }
        }
        nodes.splice(bi, 1);
        pendingBrackets--;
        if (bracket.isImage) nodes.push({ t: T_IMAGE, src: link.href, title: link.title, children });
        else nodes.push({ t: T_LINK, href: link.href, title: link.title, children });
        i = endPos; runStart = i;
      } else {
        bracket.active = false;
        pendingBrackets--;
        i++;
      }
    } else if (c === 60) { // '<'
      let gt = -1;
      for (let k = i + 1; k < n; k++) {
        const cc = text.charCodeAt(k);
        if (cc === 62) { gt = k; break; }
        if (cc === 10 || cc === 60) break;
      }
      let handled = false;
      if (gt > i + 1) {
        const inner = text.slice(i + 1, gt);
        if (SCHEME_ANGLE_RE.test(inner)) {
          addSlice(runStart, i); flush();
          nodes.push({ t: T_AUTO, href: inner, text: inner });
          i = gt + 1; runStart = i; handled = true;
        } else if (EMAIL_ANGLE_RE.test(inner)) {
          addSlice(runStart, i); flush();
          nodes.push({ t: T_AUTO, href: 'mailto:' + inner, text: inner });
          i = gt + 1; runStart = i; handled = true;
        }
      }
      if (!handled) {
        const tag = parseHtmlTag(text, i);
        if (tag) {
          // an inline <a href> opens a link context that suppresses
          // extended autolinks until a matching </a> (same rule as
          // marked: the flag persists across blocks). A self-closing
          // <a /> with whitespace before '/>' also sets it (marked
          // does not treat it as closed); '<a/>' with no space does
          // not, and a plain <a> without href does not.
          if (tag.tagName === 'a') {
            if (tag.isClose) IN_LINK = false;
            else if (tag.hasHref || (tag.text.endsWith('/>') && tag.text.length >= 3 && (tag.text.charCodeAt(tag.text.length - 3) === 32 || tag.text.charCodeAt(tag.text.length - 3) === 9 || tag.text.charCodeAt(tag.text.length - 3) === 10))) IN_LINK = true;
          }
          addSlice(runStart, i); flush();
          nodes.push({ t: T_HTML, s: tag.text });
          i = tag.end; runStart = i;
        } else {
          i++;
        }
      }
    } else if (c === 38) { // '&'
      const el = entityAt(text, i);
      if (el > 0) {
        if (text.charCodeAt(i + 1) === 35) {
          addSlice(runStart, i);
          const r = numericRef(text, i);
          const ch = String.fromCodePoint(r[0]);
          curS += ch; curH += escChar(ch);
          i += r[1]; runStart = i;
        } else {
          i += el; // named entity stays in the run
        }
      } else {
        addSlice(runStart, i);
        curS += '&'; curH += '&amp;';
        i++; runStart = i;
      }
    } else if (c === 10) { // newline: soft or hard break
      let sp = 0;
      let k = i - 1;
      while (k >= runStart && text.charCodeAt(k) === 32) { sp++; k--; }
      if (k === runStart - 1) {
        let m = curS.length - 1;
        while (m >= 0 && curS.charCodeAt(m) === 32) { sp++; m--; }
      }
      if (sp >= 2) {
        addSlice(runStart, i);
        curS = curS.slice(0, curS.length - sp);
        curH = curH.slice(0, curH.length - sp);
        flush();
        nodes.push({ t: T_BR });
        i++;
        // after a hard break, the next line's leading whitespace is stripped
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        runStart = i;
      } else {
        addSlice(runStart, i);
        flush();
        nodes.push({ t: T_SOFT });
        i++; runStart = i;
      }
    } else if (c === 119) { // 'w' — www.
      if (!IN_LINK && i + 3 < n &&
          text.charCodeAt(i + 1) === 119 && text.charCodeAt(i + 2) === 119 &&
          text.charCodeAt(i + 3) === 46 && wwwPrecedingOk(text, i, runStart)) {
        const r = scanUrlRun(text, i, refs, nodes);
        if (r && r.url.length > 4 && r.url.startsWith('www.')) {
          const dc = r.url.charCodeAt(4);
          if ((dc >= 65 && dc <= 90) || (dc >= 97 && dc <= 122) || (dc >= 48 && dc <= 57)) {
            addSlice(runStart, i); flush();
            nodes.push({ t: T_AUTO, href: 'http://' + r.url, text: r.url, ext: true });
            i = r.end; runStart = i;
            continue;
          }
        }
      }
      i++;
    } else if (c === 104 || c === 72) { // 'h'/'H' — http(s)://
      let schemeLen = 0;
      if ((text.charCodeAt(i + 1) | 32) === 116 && (text.charCodeAt(i + 2) | 32) === 116 &&
          (text.charCodeAt(i + 3) | 32) === 112) {
        if ((text.charCodeAt(i + 4) | 32) === 115) {
          if (text.charCodeAt(i + 5) === 58 && text.charCodeAt(i + 6) === 47 && text.charCodeAt(i + 7) === 47) schemeLen = 8;
        } else if (text.charCodeAt(i + 4) === 58 && text.charCodeAt(i + 5) === 47 && text.charCodeAt(i + 6) === 47) {
          schemeLen = 7;
        }
      }
      if (schemeLen > 0 && !IN_LINK) {
        const r = scanUrlRun(text, i, refs, nodes);
        if (r && r.url.length > schemeLen) {
          const hc = r.url.charCodeAt(schemeLen);
          if ((hc >= 65 && hc <= 90) || (hc >= 97 && hc <= 122) || (hc >= 48 && hc <= 57)) {
            addSlice(runStart, i); flush();
            nodes.push({ t: T_AUTO, href: r.url, text: r.url, ext: true });
            i = r.end; runStart = i;
            continue;
          }
        }
      }
      i++;
    } else if (c === 64) { // '@' — email / scheme autolink
      if (!IN_LINK) {
        let ls = i - 1;
        while (ls >= runStart && isEmailLocalChar(text.charCodeAt(ls))) ls--;
        ls++;
        if (ls < i) {
          EMAIL_STICKY.lastIndex = ls;
          const m = EMAIL_STICKY.exec(text);
          if (m && m.index === ls) {
            let emailEnd = ls + m[0].length;
            let emailText = m[0];
            // a trailing email char means the match was cut short: no link
            // -- except a '_' that is an emphasis delimiter (part of a
            // '__' run, or closing an open '_' delimiter) does not count
            const after = emailEnd < n ? text.charCodeAt(emailEnd) : -1;
            let trailingBad = (after >= 65 && after <= 90) || (after >= 97 && after <= 122) ||
                  (after >= 48 && after <= 57) || after === 45 || after === 95;
            if (trailingBad && after === 95) {
              if (emailEnd + 1 < n && text.charCodeAt(emailEnd + 1) === 95) trailingBad = false;
              else {
                for (let k = nodes.length - 1; k >= 0; k--) {
                  if (nodes[k].t === T_DELIM && nodes[k].len > 0 && nodes[k].ch === '_' && nodes[k].canOpen) { trailingBad = false; break; }
                }
              }
            }
            if (trailingBad && (after === 95 || after === 45)) {
              // lone trailing '_'/'-': drop the last domain label; if the
              // domain still has a dot, link the shortened address
              const lastDot = emailText.lastIndexOf('.');
              const atIdx = emailText.indexOf('@');
              if (lastDot > atIdx + 1 && emailText.slice(atIdx + 1, lastDot).includes('.')) {
                emailText = emailText.slice(0, lastDot);
                emailEnd = ls + lastDot;
                trailingBad = false;
              }
            }
            if (!trailingBad) {
              // check for a preceding scheme (mailto: / xmpp: / ...)
              let linkStart = ls, linkEnd = emailEnd, linkHref = 'mailto:' + emailText;
              if (ls >= 2 && text.charCodeAt(ls - 1) === 58) {
                let ss = ls - 2;
                while (ss >= runStart && isSchemeChar(text.charCodeAt(ss))) ss--;
                ss++;
                const schemeLen = ls - 1 - ss;
                if (schemeLen >= 2 && schemeLen <= 32 &&
                    ((text.charCodeAt(ss) >= 65 && text.charCodeAt(ss) <= 90) ||
                     (text.charCodeAt(ss) >= 97 && text.charCodeAt(ss) <= 122))) {
                  const scheme = text.slice(ss, ls - 1);
                  linkStart = ss;
                  if (scheme.toLowerCase() === 'mailto') {
                    linkEnd = emailEnd;
                    linkHref = text.slice(ss, emailEnd);
                  } else {
                    // other schemes: email + optional single path segment
                    linkEnd = emailEnd;
                    if (emailEnd < n && text.charCodeAt(emailEnd) === 47) {
                      let pe = emailEnd + 1;
                      while (pe < n) {
                        const pc = text.charCodeAt(pe);
                        if (pc === 32 || pc === 9 || pc === 10 || pc === 12 || pc === 13 ||
                            pc === 60 || pc === 47) break;
                        pe++;
                      }
                      if (pe > emailEnd + 1) linkEnd = pe;
                    }
                    // trim trailing punctuation from the whole link
                    while (linkEnd > emailEnd && isUrlTrailPunct(text.charCodeAt(linkEnd - 1))) linkEnd--;
                    linkHref = text.slice(ss, linkEnd);
                  }
                }
              }
              addSlice(runStart, linkStart); flush();
              nodes.push({ t: T_AUTO, href: linkHref, text: text.slice(linkStart, linkEnd), ext: true });
              i = linkEnd; runStart = i;
              continue;
            }
          }
        }
      }
      i++;
    } else {
      // ordinary char: jump to the next potentially-special char with the
      // native regex scanner instead of stepping char by char (only
      // worth it when enough text remains; for short tails i++ is cheaper)
      if (n - i > 24) {
        NEXT_SPECIAL_RE.lastIndex = i;
        const m = NEXT_SPECIAL_RE.exec(text);
        i = m ? m.index : n;
      } else {
        i++;
      }
    }
  }
  addSlice(runStart, n); flush();
  processEmphasis(nodes);
  return renderNodes(nodes);
}

// ---------- block parsing ----------
// Block node types: para, heading, code, fence, hr, html, bq, list, table.

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

function matchATX(line) {
  const indent = indentCols(line);
  if (indent > 3) return null;
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let level = 0;
  while (i < line.length && line.charCodeAt(i) === 35) { level++; i++; }
  if (level === 0 || level > 6) return null;
  if (i < line.length && line.charCodeAt(i) !== 32 && line.charCodeAt(i) !== 9) return null;
  let text = line.slice(i).trim();
  const m = text.match(/^(.*?)[ \t]+#+$/);
  if (m) text = m[1].trim();
  else if (/^#+$/.test(text)) text = '';
  return { level, text };
}

function matchFence(line) {
  const indent = indentCols(line);
  if (indent > 3) return null;
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  if (c !== 96 && c !== 126) return null;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  const len = j - i;
  if (len < 3) return null;
  const info = line.slice(j).trim();
  if (c === 96 && info.includes('`')) return null;
  return { ch: c === 96 ? '`' : '~', len, indent, info };
}

function isThematicBreak(line) {
  if (indentCols(line) > 3) return false;
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i >= line.length) return false;
  const c = line.charCodeAt(i);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  let count = 0;
  while (i < line.length) {
    const cc = line.charCodeAt(i);
    if (cc === c) { count++; i++; }
    else if (cc === 32 || cc === 9) i++;
    else return false;
  }
  return count >= 3;
}

// Is the line a setext underline? Indent must be <= 3, then a contiguous
// run of one char ('=' or '-'), then only spaces/tabs to EOL. No internal
// spaces: "= =" and "--- -" are NOT underlines. Returns '=' / '-' / null.
function setextChar(line) {
  if (indentCols(line) > 3) return null;
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  if (c !== 61 && c !== 45) return null;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j < line.length) return null;
  return c === 61 ? '=' : '-';
}

// HTML block start type (0 = none). inPara = whether we're inside a
// paragraph (type 7 does not interrupt a paragraph).
function htmlBlockStart(line, inPara) {
  if (indentCols(line) > 3) return 0;
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i >= line.length || line.charCodeAt(i) !== 60) return 0;
  const rest = line.slice(i);
  const low = rest.toLowerCase();
  // type 1: script/pre/style/textarea
  if (low.startsWith('<script') || low.startsWith('<pre') || low.startsWith('<style') || low.startsWith('<textarea')) {
    const after = rest.length > 7 ? rest.charCodeAt(7) : -1;
    // need the tag name to end: next char must be ws, '>', or '/'
    // (check the char right after the matched tag name)
    const nameLen = low.startsWith('<script') ? 7 : low.startsWith('<textarea') ? 9 : low.startsWith('<style') ? 6 : 4;
    const nc = rest.length > nameLen ? rest.charCodeAt(nameLen) : -1;
    if (nc === -1 || nc === 32 || nc === 9 || nc === 10 || nc === 62 || nc === 47) return 1;
  }
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (rest.startsWith('<!')) {
    const c2 = rest.length > 2 ? rest.charCodeAt(2) : -1;
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) return 4;
    if (rest.startsWith('<![CDATA[')) return 5;
  }
  // type 6: < or </ + block tag, followed by ws/EOL/'>'/'/>'
  let j = i + 1;
  if (j < line.length && line.charCodeAt(j) === 47) j++;
  let k = j;
  while (k < line.length) {
    const cc = line.charCodeAt(k);
    if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 45) k++;
    else break;
  }
  if (k > j) {
    const name = line.slice(j, k).toLowerCase();
    const nc = k < line.length ? line.charCodeAt(k) : -1;
    if ((nc === -1 || nc === 32 || nc === 9 || nc === 62 || nc === 47) && BLOCK_TAGS.has(name)) return 6;
  }
  // type 7: exactly one complete tag, nothing else on the line
  if (!inPara) {
    const tag = parseHtmlTag(line, i);
    if (tag) {
      let e = tag.end;
      while (e < line.length && (line.charCodeAt(e) === 32 || line.charCodeAt(e) === 9)) e++;
      if (e >= line.length) return 7;
    }
  }
  return 0;
}

// End-condition check for HTML block types 1-5: does this line contain
// the terminator?
function htmlBlockEnds(line, type) {
  const low = line.toLowerCase();
  if (type === 1) return low.includes('</script') || low.includes('</pre') || low.includes('</style') || low.includes('</textarea');
  if (type === 2) return line.includes('-->');
  if (type === 3) return line.includes('?>');
  if (type === 4) return line.includes('>');
  if (type === 5) return line.includes(']]>');
  return false;
}

// Match a list item marker. Returns null or
// {ordered, marker, delim, start, contentIndent, contentStart}.
function matchList(line) {
  const indent = indentCols(line);
  if (indent > 3) return null;
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  let ordered = false, marker = '', delim = '', start = 0, markerEnd = i;
  if (c === 45 || c === 43 || c === 42) {
    const nc = i + 1 < line.length ? line.charCodeAt(i + 1) : -1;
    if (nc !== -1 && nc !== 32 && nc !== 9) return null;
    marker = String.fromCharCode(c);
    markerEnd = i + 1;
  } else if (c >= 48 && c <= 57) {
    let j = i, digits = 0;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) { digits++; j++; }
    if (digits === 0 || digits > 9) return null;
    const d = j < line.length ? line.charCodeAt(j) : -1;
    if (d !== 46 && d !== 41) return null;
    const nc = j + 1 < line.length ? line.charCodeAt(j + 1) : -1;
    if (nc !== -1 && nc !== 32 && nc !== 9) return null;
    ordered = true;
    marker = line.slice(i, j + 1);
    delim = d === 46 ? '.' : ')';
    start = parseInt(line.slice(i, j), 10);
    markerEnd = j + 1;
  } else return null;
  // content indent in columns
  const markerWidth = markerEnd - i; // 1 for bullet, digits+1 for ordered
  let col = indent + markerWidth;
  let k = markerEnd, wsCols = 0;
  while (k < line.length) {
    const cc = line.charCodeAt(k);
    if (cc === 32) { k++; col++; wsCols++; }
    else if (cc === 9) { const w = 4 - (col & 3); k++; col += w; wsCols += w; }
    else break;
  }
  let contentIndent, contentStart;
  if (k >= line.length) {
    contentIndent = indent + markerWidth + 1;
    contentStart = -1;
  } else if (wsCols >= 5) {
    contentIndent = indent + markerWidth + 1;
    contentStart = k;
  } else {
    contentIndent = col;
    contentStart = k;
  }
  return { ordered, marker, delim, start, contentIndent, contentStart, markerCol: indent };
}

// ---------- reference definitions ----------
// Skip spaces/tabs/newlines from q; returns the new index, or -1 if a
// blank line (two newlines) is crossed.
function skipDefWs(text, q) {
  const n = text.length;
  let newlines = 0;
  while (q < n) {
    const cc = text.charCodeAt(q);
    if (cc === 32 || cc === 9) q++;
    else if (cc === 10) {
      newlines++;
      if (newlines >= 2) return -1;
      q++;
    } else break;
  }
  return q;
}

// Parse a link destination at text[q] (angle or bare). Returns
// {dest, end} or null.
function parseDest(text, q) {
  const n = text.length;
  if (q >= n) return null;
  if (text.charCodeAt(q) === 60) { // '<'
    let k = q + 1, dest = '';
    while (k < n) {
      const cc = text.charCodeAt(k);
      if (cc === 92) {
        const nc = k + 1 < n ? text.charCodeAt(k + 1) : -1;
        if (nc >= 0 && isAsciiPunct(nc)) { dest += text[k + 1]; k += 2; }
        else { dest += '\\'; k++; }
      } else if (cc === 62) return { dest, end: k + 1 };
      else if (cc === 10) return null;
      else { dest += text[k]; k++; }
    }
    return null;
  }
  let k = q, depth = 0, dest = '';
  while (k < n) {
    const cc = text.charCodeAt(k);
    if (cc === 92) {
      const nc = k + 1 < n ? text.charCodeAt(k + 1) : -1;
      if (nc >= 0 && isAsciiPunct(nc)) { dest += text[k + 1]; k += 2; }
      else { dest += '\\'; k++; }
    } else if (cc === 40) { depth++; dest += '('; k++; }
    else if (cc === 41) {
      if (depth === 0) break;
      depth--; dest += ')'; k++;
    } else if (cc === 32 || cc === 9 || cc === 10 || cc < 32) break;
    else { dest += text[k]; k++; }
  }
  if (dest === '' || depth > 0) return null;
  return { dest, end: k };
}

// Parse leading link reference definitions out of a paragraph's joined
// text. Registers them in refs (first definition wins). Returns the
// remaining text.
function parseRefDefs(text, refs) {
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    // '[' must be within 3 columns of the line start
    let p = pos, col = 0;
    while (p < n) {
      const cc = text.charCodeAt(p);
      if (cc === 32) { p++; col++; }
      else if (cc === 9) { col += 4 - (col & 3); p++; }
      else break;
      if (col > 3) break;
    }
    if (col > 3 || p >= n || text.charCodeAt(p) !== 91) break;
    // label: [ ... ] (no unescaped '[' allowed inside a label)
    let k = p + 1, labelEnd = -1;
    while (k < n) {
      const cc = text.charCodeAt(k);
      if (cc === 92) { k += 2; continue; }
      if (cc === 91) break; // '[' not allowed in a label
      if (cc === 93) { labelEnd = k; break; }
      k++;
    }
    if (labelEnd < 0) break;
    const labelRaw = text.slice(p + 1, labelEnd);
    if (labelRaw.trim() === '') break;
    let q = labelEnd + 1;
    if (q >= n || text.charCodeAt(q) !== 58) break; // ':'
    q++;
    q = skipDefWs(text, q);
    if (q < 0) break;
    const d = parseDest(text, q);
    if (!d) break;
    const de = d.end;
    // end of the dest's line
    let lineEnd = de;
    while (lineEnd < n && text.charCodeAt(lineEnd) !== 10) lineEnd++;
    // optional title
    const q2 = skipDefWs(text, de);
    if (q2 < 0) break;
    let title = null, defEnd;
    const nlIdx = text.indexOf('\n', de);
    const skippedNl = q2 > de && nlIdx >= 0 && nlIdx < q2;
    if (q2 < n && q2 > de) {
      const tc = text.charCodeAt(q2);
      if (tc === 34 || tc === 39 || tc === 40) {
        const t = parseTitle(text, q2);
        if (t) {
          let q3 = t.end;
          while (q3 < n && (text.charCodeAt(q3) === 32 || text.charCodeAt(q3) === 9)) q3++;
          if (q3 < n && text.charCodeAt(q3) !== 10) {
            if (!skippedNl) break; // same-line title followed by junk -> invalid def
            // later-line title followed by junk: no title
          } else {
            title = t.title;
            defEnd = q3;
          }
        } else if (!skippedNl) {
          break; // same-line title is malformed -> invalid def
        }
        // malformed later-line title: no title, fall through
      }
    }
    if (defEnd === undefined) {
      // no title: only whitespace may remain on the dest's line
      let q3 = de;
      while (q3 < lineEnd && (text.charCodeAt(q3) === 32 || text.charCodeAt(q3) === 9)) q3++;
      if (q3 < lineEnd) break;
      defEnd = lineEnd;
    }
    const norm = normLabel(labelRaw);
    if (!refs.has(norm)) refs.set(norm, { href: d.dest, title });
    pos = defEnd < n ? defEnd + 1 : defEnd;
  }
  return text.slice(pos);
}

// ---------- tables ----------
// Split a table row on unescaped '|'. Returns raw (untrimmed) parts, with
// the first/last part dropped when the row starts/ends with an unescaped '|'.
// An escaped pipe "\|" becomes a literal '|' in the cell (the escape is
// resolved at extraction, before inline parsing).
function splitTableRow(line) {
  const parts = [];
  let seg = '', segStart = 0, i = 0;
  const n = line.length;
  while (i < n) {
    const cc = line.charCodeAt(i);
    if (cc === 92 && i + 1 < n) {
      const nc = line.charCodeAt(i + 1);
      if (nc === 124) {
        seg += line.slice(segStart, i) + '|';
        i += 2; segStart = i;
      } else {
        // keep the escape pair as-is; skip both so the next char is not
        // misread (e.g. \\| must split on the |)
        i += 2;
      }
    } else if (cc === 124) {
      seg += line.slice(segStart, i);
      parts.push(seg); seg = '';
      i++;
      segStart = i;
    } else i++;
  }
  seg += line.slice(segStart);
  parts.push(seg);
  // a leading '|' (after optional whitespace) is a delimiter, not an
  // empty first cell; same for a trailing '|' (before optional ws)
  if (parts.length > 0 && isSpacesOnly(parts[0])) {
    let k = 0;
    while (k < n && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
    if (k < n && line.charCodeAt(k) === 124) parts.shift();
  }
  if (parts.length > 0 && isSpacesOnly(parts[parts.length - 1])) {
    let k = n - 1;
    while (k >= 0 && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k--;
    if (k >= 0 && line.charCodeAt(k) === 124) parts.pop();
  }
  return parts;
}
function trimCellSpaces(s) {
  let a = 0, b = s.length;
  while (a < b && s.charCodeAt(a) === 32) a++;
  while (b > a && s.charCodeAt(b - 1) === 32) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}
function isSpacesOnly(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) !== 32) return false;
  return true;
}
function trimCell(s) { return s.replace(/^[ \t]+|[ \t]+$/g, ''); }

// Validate a delimiter row. Returns the aligns array or null.
// Delimiter cells allow only spaces (0x20) around ':?-+:?'.
function tableDelimAligns(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const raw of cells) {
    const cell = trimCellSpaces(raw);
    let s = 0, e = cell.length, left = false, right = false;
    if (e > 0 && cell.charCodeAt(0) === 58) { left = true; s = 1; }
    if (e > s && cell.charCodeAt(e - 1) === 58) { right = true; e--; }
    if (e - s < 1) return null;
    for (let k = s; k < e; k++) {
      if (cell.charCodeAt(k) !== 45) return null;
    }
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

function isBqStart(line) {
  if (indentCols(line) > 3) return false;
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i < line.length && line.charCodeAt(i) === 62;
}

// Does this line start a block that interrupts a paragraph?
function isInterruptingBlock(line, inListItem = false) {
  // fast path: indent must be <= 3 and the first non-ws char must be one
  // of # ` ~ - _ * + > < or a digit (ATX, fence, thematic break,
  // blockquote, list, HTML) — anything else cannot interrupt
  let i = 0, col = 0;
  while (i < line.length) {
    const cc = line.charCodeAt(i);
    if (cc === 32) { i++; col++; }
    else if (cc === 9) { col += 4 - (col & 3); i++; }
    else break;
  }
  if (col > 3 || i >= line.length) return false;
  const c = line.charCodeAt(i);
  if (c !== 35 && c !== 96 && c !== 126 && c !== 45 && c !== 95 && c !== 42 &&
      c !== 43 && c !== 62 && c !== 60 && !(c >= 48 && c <= 57)) return false;
  if (matchATX(line)) return true;
  if (matchFence(line)) return true;
  if (isThematicBreak(line)) return true;
  if (isBqStart(line)) return true;
  const lm = matchList(line);
  if (lm && lm.contentStart >= 0) {
    if (!lm.ordered) return true;
    // inside a list item, an ordered list interrupts a paragraph
    // regardless of its start number; elsewhere only start == 1 does
    if (inListItem || lm.start === 1) return true;
  }
  const ht = htmlBlockStart(line, true);
  if (ht >= 1 && ht <= 6) return true;
  return false;
}

// ---------- block collection ----------
// Does a list of lines (already collected) end with a paragraph?
// Used for lazy-line decisions in blockquotes and list items.
// Does the block list end with a paragraph (deep: through blockquotes
// and into the last item of a list)? Used for lazy-line continuation.
function blockEndsWithPara(lines, refs) {
  const blocks = parseBlocks(lines, refs, 0, lines.length, false);
  if (blocks.length === 0) return false;
  return endsWithPara(blocks[blocks.length - 1], refs);
}
function endsWithPara(b, refs) {
  if (b.t === 'para') return true;
  if (b.t === 'bq') {
    return b.children.length > 0 && endsWithPara(b.children[b.children.length - 1], refs);
  }
  if (b.t === 'list') {
    if (b.items.length === 0) return false;
    const lastLines = b.items[b.items.length - 1];
    const ib = parseBlocks(lastLines, refs, 0, lastLines.length, false, false, true);
    return ib.length > 0 && endsWithPara(ib[ib.length - 1], refs);
  }
  return false;
}

// A lazy line must not start an interrupting block (ATX, fence, thematic
// break, blockquote, list, HTML 1-6). '===' is allowed (literal text);
// '---' is a thematic break, so it is not allowed.
function isLazyInterrupting(line) {
  if (matchATX(line)) return true;
  if (matchFence(line)) return true;
  if (isThematicBreak(line)) return true;
  if (isBqStart(line)) return true;
  const lm = matchList(line);
  if (lm && lm.contentStart >= 0) {
    if (!lm.ordered) return true;
    if (lm.start === 1) return true;
  }
  const ht = htmlBlockStart(line, true);
  if (ht >= 1 && ht <= 6) return true;
  return false;
}

function collectBlockquote(lines, i, hi, refs, atEnd) {
  const bqLines = [];
  let j = i;
  while (j < hi) {
    const line = lines[j];
    if (isBlankLine(line)) break;
    if (isBqStart(line)) {
      // strip up to 3 spaces, '>', then one space (or a tab, column-aware)
      let k = 0, col = 0;
      while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) {
        if (line.charCodeAt(k) === 32) { k++; col++; }
        else { col += 4 - (col & 3); k++; }
      }
      const gtCol = col;
      k++; // skip '>'
      let content;
      if (k < line.length && line.charCodeAt(k) === 32) {
        k++;
        // the content starts at column gtCol+2; a leading tab there
        // expands using its original column (e.g. '> \tfoo' -> '  foo')
        content = expandTabs(line.slice(k), gtCol + 2);
      } else if (k < line.length && line.charCodeAt(k) === 9) {
        // the tab is the "one space": it is partially consumed (1 column),
        // the rest becomes spaces; the following leading whitespace is
        // expanded using its original columns
        const tabEnd = (Math.floor((gtCol + 1) / 4) + 1) * 4;
        const spaces = tabEnd - gtCol - 2;
        content = ' '.repeat(spaces > 0 ? spaces : 0) + expandTabs(line.slice(k + 1), tabEnd);
      } else {
        content = line.slice(k);
      }
      // a stripped content of only spaces is paragraph text (not a blank
      // line) when the quote ends with a paragraph: merge it into the
      // paragraph; otherwise it separates blocks, so skip it
      if (content.length > 0 && isBlankLine(content)) {
        if (bqLines.length > 0 && blockEndsWithPara(bqLines, refs)) {
          bqLines[bqLines.length - 1] += '\n' + content;
        }
      } else {
        bqLines.push(content);
      }
      j++;
    } else {
      // lazy line: it continues the current paragraph, so merge it into
      // the paragraph's line (never a new block start)
      if (bqLines.length > 0 && !isBlankLine(bqLines[bqLines.length - 1]) &&
          blockEndsWithPara(bqLines, refs) && !isLazyInterrupting(line)) {
        const ind = indentCols(line);
        let stripped = ind >= 4 ? stripCols(line, 4) : line;
        // a lazy setext-underline candidate gets 4 spaces prepended
        // (so it stays literal text with those spaces)
        if (setextChar(stripped)) stripped = '    ' + stripped;
        bqLines[bqLines.length - 1] += '\n' + stripped;
        j++;
      } else break;
    }
  }
  const innerAtEnd = atEnd && j >= hi;
  const children = parseBlocks(bqLines, refs, 0, bqLines.length, innerAtEnd);
  return { node: { t: 'bq', children }, next: j };
}

// Collect a list starting at lines[i]. Returns {node, next}.
function collectList(lines, i, hi, refs, atEnd) {
  const first = matchList(lines[i]);
  const ordered = first.ordered;
  const sameType = (lm) => lm && lm.ordered === ordered &&
    (ordered ? lm.delim === first.delim : lm.marker === first.marker);
  const items = [];
  let loose = false;
  let j = i;
  let cur = null; // {lines: [], indent: n, lastPara: bool}
  let pendingBlanks = 0;

  const flushItem = () => {
    if (!cur) return;
    while (cur.lines.length > 0 && cur.lines[cur.lines.length - 1] === '') cur.lines.pop();
    items.push(cur.lines); // keep empty items: they render as <li></li>
    cur = null;
  };

  while (j < hi) {
    const line = lines[j];
    if (isBlankLine(line)) {
      pendingBlanks++;
      j++;
      continue;
    }
    const indent = indentCols(line);
    const lm = matchList(line);
    // a thematic break at the list level ends the list
    if (cur && indent < cur.indent && isThematicBreak(line)) break;
    // new item of this list?
    if (cur && lm && sameType(lm) && indent < cur.indent) {
      if (pendingBlanks > 0) loose = true;
      flushItem();
      pendingBlanks = 0;
      cur = { lines: [], indent: lm.contentIndent, lastPara: false };
      // first line of the new item
      if (lm.contentStart >= 0) {
        cur.lines.push(stripNCols(line, lm.contentIndent));
        cur.lastPara = true;
      } else {
        cur.lastPara = false;
      }
      j++;
      continue;
    }
    if (!cur) {
      // first item
      cur = { lines: [], indent: first.contentIndent, lastPara: false };
      if (first.contentStart >= 0) {
        cur.lines.push(stripNCols(line, first.contentIndent));
        cur.lastPara = true;
      }
      j++;
      continue;
    }
    // a different list type at the list level ends this list
    if (lm && indent < cur.indent) {
      break;
    }
    // a line belonging to the current item
    if (indent >= cur.indent) {
      // an empty item cannot continue after a blank line
      if (pendingBlanks > 0 && cur.lines.length === 0) break;
      // (looseness is computed from the item's parsed blocks, not here:
      // blank lines inside a nested container must not loosen this list)
      while (pendingBlanks > 0) { cur.lines.push(''); pendingBlanks--; }
      cur.lines.push(stripNCols(line, cur.indent));
      // update lastPara: a plain line means paragraph; a block start means not
      cur.lastPara = !isInterruptingBlock(line) && setextChar(line) === null &&
        matchFence(line) === null && !isThematicBreak(line);
      // a setext underline or table delimiter ends the paragraph
      if (setextChar(line) !== null) cur.lastPara = false;
      j++;
      continue;
    }
    // lazy continuation line (indent < contentIndent): it continues the
    // current paragraph, so merge it into the paragraph's line
    if (pendingBlanks === 0 && cur.lastPara && !isLazyInterrupting(line) &&
        setextChar(line) !== '=') {
      // '---' is a thematic break (isLazyInterrupting covers it); '===' is
      // literal text, so it is allowed as a lazy line
      const ind = indentCols(line);
      let stripped = ind >= 4 ? stripCols(line, 4) : line;
      if (setextChar(stripped)) stripped = '    ' + stripped;
      cur.lines[cur.lines.length - 1] += '\n' + stripped;
      cur.lastPara = true;
      j++;
      continue;
    }
    break; // does not belong to this list
  }
  if (pendingBlanks > 0 && cur && cur.lines.length > 0) {
    // trailing blanks after the last item: they make the list loose only if
    // there is a following item; here there is none, so ignore
  }
  flushItem();
  // blank lines that were never claimed by an item are left for the caller
  // to see (they separate blocks at the outer level)
  const next = (pendingBlanks > 0 && j < hi) ? j - pendingBlanks : j;
  return { node: { t: 'list', ordered, start: ordered ? first.start : null, items, loose }, next };
}

// Collect a paragraph starting at lines[i]. Handles setext headings and
// tables. Returns {nodes, next}.
function collectParagraph(lines, i, hi, refs, inListItem = false) {
  const paraLines = [lines[i]];
  let j = i + 1;
  let tableAt = -1; // index in paraLines of the table header, if a table follows
  while (j < hi) {
    const line = lines[j];
    if (isBlankLine(line)) break;
    const sc = setextChar(line);
    if (sc) {
      // a setext underline only counts if the paragraph text so far
      // (after refdef removal) is non-empty; otherwise the line is
      // literal text and collection continues
      const soFar = parseRefDefs(paraLines.join('\n'), refs);
      if (soFar.trim() !== '') {
        paraLines.push(line);
        j++;
        break; // setext heading: paragraph ends here
      }
      // else: literal text, fall through and keep collecting
    }
    // table delimiter? (must be at indent < 4)
    const aligns = indentCols(line) < 4 ? tableDelimAligns(line) : null;
    if (aligns) {
      const headerCells = splitTableRow(paraLines[paraLines.length - 1]).map(trimCell);
      if (headerCells.length === aligns.length) {
        tableAt = paraLines.length - 1;
        j++; // consume the delimiter line
        break;
      }
    }
    if (isInterruptingBlock(line, inListItem)) break;
    paraLines.push(line);
    j++;
  }
  const nodes = [];
  if (tableAt >= 0) {
    // lines before the header form their own paragraph (if any)
    if (tableAt > 0) {
      const pre = paraLines.slice(0, tableAt);
      const rest = parseRefDefs(pre.join('\n'), refs);
      if (rest.trim() !== '') nodes.push({ t: 'para', text: rest });
    }
    const headerLine = paraLines[tableAt];
    const delimLine = lines[j - 1];
    const headerCells = splitTableRow(headerLine).map(trimCell);
    const aligns = tableDelimAligns(delimLine);
    const rows = [];
    let k = j;
    while (k < hi) {
      const line = lines[k];
      // marked quirk: a line of exactly a tab (or space+tab) counts as
      // an (empty) table body row; any other blank line ends the table
      const tabRow = line === '\t' || line === ' \t';
      if (isBlankLine(line) && !tabRow) break;
      if (indentCols(line) >= 4 && !tabRow) break;
      if (isInterruptingBlock(line, inListItem)) break;
      rows.push(splitTableRow(line).map(trimCell));
      k++;
    }
    nodes.push({ t: 'table', header: headerCells, aligns, rows });
    return { nodes, next: k };
  }
  // setext heading?
  const lastSc = setextChar(paraLines[paraLines.length - 1]);
  if (lastSc && paraLines.length > 1) {
    const text = paraLines.slice(0, -1).join('\n');
    const rest = parseRefDefs(text, refs);
    // heading text is trimmed (leading/trailing whitespace removed)
    const trimmed = rest.trim();
    if (trimmed !== '') {
      nodes.push({ t: 'heading', level: lastSc === '=' ? 1 : 2, text: trimmed });
      return { nodes, next: j };
    }
    // empty after refdef removal: not a heading, fall through to paragraph
  }
  const text = paraLines.join('\n');
  const rest = parseRefDefs(text, refs);
  if (rest.trim() !== '') nodes.push({ t: 'para', text: rest });
  return { nodes, next: j };
}

function matchFenceClose(line, fence) {
  if (indentCols(line) > 3) return false;
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i >= line.length) return false;
  const c = line.charCodeAt(i);
  if ((fence.ch === '`' && c !== 96) || (fence.ch === '~' && c !== 126)) return false;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  if (j - i < fence.len) return false;
  // no info string allowed
  let k = j;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  return k >= line.length;
}

// ---------- main block parser ----------
// Parse lines[lo..hi) into block nodes. atEnd = whether lines[hi-1] is
// the last line of the original input (affects HTML block trailing newline).
let INPUT_ENDS_WITH_NL = false;

function parseBlocks(lines, refs, lo, hi, atEnd, topLevel = false, inListItem = false) {
  const blocks = [];
  // loose = a blank line separates two top-level blocks in this range
  // (blank lines consumed by nested containers do not set it)
  blocks.loose = false;
  let sawBlank = false;
  let i = lo;
  while (i < hi) {
    const line = lines[i];
    if (isBlankLine(line)) { sawBlank = true; i++; continue; }
    if (blocks.length > 0 && sawBlank) blocks.loose = true;
    sawBlank = false;
    const indent = indentCols(line);
    // indented code
    if (indent >= 4) {
      const codeLines = [];
      while (i < hi) {
        const l = lines[i];
        if (isBlankLine(l)) {
          let j = i + 1;
          while (j < hi && isBlankLine(lines[j])) j++;
          if (j < hi && indentCols(lines[j]) >= 4) {
            // interior blank line keeps its stripped content (spaces)
            while (i < j) { codeLines.push(stripCols(lines[i], 4)); i++; }
          } else break;
        } else if (indentCols(l) >= 4) {
          codeLines.push(stripCols(l, 4));
          i++;
        } else break;
      }
      while (codeLines.length > 0 && isBlankLine(codeLines[codeLines.length - 1])) codeLines.pop();
      blocks.push({ t: 'code', text: codeLines.length > 0 ? codeLines.join('\n') + '\n' : '' });
      continue;
    }
    // ATX heading
    const atx = matchATX(line);
    if (atx) { blocks.push({ t: 'heading', level: atx.level, text: atx.text }); i++; continue; }
    // fenced code
    const fence = matchFence(line);
    if (fence) {
      const content = [];
      let j = i + 1;
      // backtick fences strip the fence indent from content lines;
      // tilde fences do NOT strip it (marked quirk, probed) — their
      // content lines are kept as-is
      const stripN = fence.ch === '`' ? fence.indent : 0;
      while (j < hi) {
        if (matchFenceClose(lines[j], fence)) { j++; break; }
        content.push(stripN > 0 ? stripCols(lines[j], stripN) : lines[j]);
        j++;
      }
      // content = lines joined with '\n'; a trailing '\n' is added only
      // when the content does not already end with one (i.e. the last
      // line is not blank)
      let ftext = content.join('\n');
      if (ftext !== '' && !ftext.endsWith('\n')) ftext += '\n';
      blocks.push({ t: 'fence', text: ftext, info: fence.info });
      i = j;
      continue;
    }
    // thematic break
    if (isThematicBreak(line)) { blocks.push({ t: 'hr' }); i++; continue; }
    // HTML block
    const ht = htmlBlockStart(line, false);
    if (ht > 0) {
      const htmlLines = [line];
      let j = i + 1;
      if (ht <= 5) {
        if (!htmlBlockEnds(line, ht)) {
          while (j < hi) {
            htmlLines.push(lines[j]);
            if (htmlBlockEnds(lines[j], ht)) { j++; break; }
            j++;
          }
        }
      } else {
        while (j < hi && !isBlankLine(lines[j])) { htmlLines.push(lines[j]); j++; }
      }
      // trailing newline: types 1-5 (terminator-ended) get one when the
      // following line is not empty (a whitespace-only line still
      // counts); types 6-7 (blank-line-ended) get one only when the
      // following line is non-blank. At the end of the range, top level
      // follows whether the input ends with a newline; a nested block
      // at the end of its container never gets one
      const hasNl = j < hi
        ? (ht <= 5 ? lines[j].length > 0 : !isBlankLine(lines[j]))
        : (topLevel ? INPUT_ENDS_WITH_NL : false);
      blocks.push({ t: 'html', text: htmlLines.join('\n'), hasNl });
      i = j;
      continue;
    }
    // blockquote
    if (isBqStart(line)) {
      const res = collectBlockquote(lines, i, hi, refs, atEnd);
      blocks.push(res.node);
      i = res.next;
      continue;
    }
    // list
    if (matchList(line)) {
      const res = collectList(lines, i, hi, refs, atEnd);
      blocks.push(res.node);
      i = res.next;
      continue;
    }
    // paragraph / setext / table
    const res = collectParagraph(lines, i, hi, refs, inListItem);
    for (const b of res.nodes) blocks.push(b);
    i = res.next;
  }
  return blocks;
}

// ---------- block rendering ----------
// Task-list checkbox at the very start of a paragraph's text.
// Returns {box, rest} or null. `rest` is the text after the 3-char marker
// (leading whitespace preserved). The marker must be followed by
// whitespace and then non-whitespace content.
function taskCheckbox(text) {
  if (text.length < 4) return null;
  if (text.charCodeAt(0) !== 91) return null; // '['
  const m = text.charCodeAt(1);
  if (m !== 32 && m !== 120 && m !== 88) return null; // ' ', 'x', 'X'
  if (text.charCodeAt(2) !== 93) return null; // ']'
  const c3 = text.charCodeAt(3);
  if (c3 !== 32 && c3 !== 9) return null; // must be followed by ws
  let k = 3;
  while (k < text.length && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  if (k >= text.length) return null; // only whitespace after -> not a checkbox
  const checked = m === 120 || m === 88;
  const box = checked
    ? '<input checked="" disabled="" type="checkbox">'
    : '<input disabled="" type="checkbox">';
  return { box, rest: text.slice(3) };
}

function renderBlocks(blocks, refs, tightList) {
  let out = '';
  for (const b of blocks) {
    switch (b.t) {
      case 'para': {
        const inner = parseInline(b.text, refs);
        // in a tight list a paragraph renders as its bare inline content
        // (no <p>, no trailing newline)
        out += tightList ? inner : '<p>' + inner + '</p>\n';
        break;
      }
      case 'heading':
        out += '<h' + b.level + '>' + parseInline(b.text, refs) + '</h' + b.level + '>\n';
        break;
      case 'code':
        out += '<pre><code>' + escCode(b.text) + '</code></pre>\n';
        break;
      case 'fence': {
        let info = '';
        if (b.info) {
          const word = unescapeStr(b.info.split(/[ \t]/, 1)[0]);
          if (word) info = ' class="language-' + escText(word) + '"';
        }
        out += '<pre><code' + info + '>' + escCode(b.text) + '</code></pre>\n';
        break;
      }
      case 'hr':
        out += '<hr>\n';
        break;
      case 'html':
        out += b.text + (b.hasNl ? '\n' : '');
        break;
      case 'bq':
        out += '<blockquote>\n' + renderBlocks(b.children, refs, false) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out += '<' + tag;
        if (b.ordered && b.start !== 1) out += ' start="' + b.start + '"';
        out += '>\n';
        // parse all items first: the list is loose if items are separated
        // by a blank line (b.loose) or any item's top-level blocks are
        // blank-line separated (blocks.loose)
        const parsedItems = b.items.map(itemLines =>
          parseBlocks(itemLines, refs, 0, itemLines.length, false, false, true));
        let loose = b.loose;
        for (const ib of parsedItems) if (ib.loose) { loose = true; break; }
        const tight = !loose;
        for (let ii = 0; ii < parsedItems.length; ii++) {
          const itemBlocks = parsedItems[ii];
          // task checkbox: first block is a para starting with [] / [x] / [X]
          let checkbox = null;
          if (itemBlocks.length >= 1 && itemBlocks[0].t === 'para') {
            checkbox = taskCheckbox(itemBlocks[0].text);
          }
          out += '<li>';
          for (let bi = 0; bi < itemBlocks.length; bi++) {
            const ib = itemBlocks[bi];
            if (ib.t === 'para') {
              const txt = (bi === 0 && checkbox) ? checkbox.rest : ib.text;
              const rendered = parseInline(txt, refs);
              if (tight) {
                out += (bi === 0 && checkbox) ? checkbox.box + rendered : rendered;
              } else {
                out += '<p>' + ((bi === 0 && checkbox) ? checkbox.box + rendered : rendered) + '</p>\n';
              }
            } else {
              out += renderBlocks([ib], refs, false);
            }
          }
          out += '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let ci = 0; ci < b.header.length; ci++) {
          const al = b.aligns[ci];
          out += '<th' + (al ? ' align="' + al + '"' : '') + '>' +
            parseInline(b.header[ci], refs) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (b.rows.length > 0) {
          out += '<tbody>';
          for (const row of b.rows) {
            out += '<tr>\n';
            for (let ci = 0; ci < b.header.length; ci++) {
              const cell = ci < row.length ? row[ci] : '';
              const al = b.aligns[ci];
              out += '<td' + (al ? ' align="' + al + '"' : '') + '>' +
                parseInline(cell, refs) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
    }
  }
  return out;
}

// ---------- entry point ----------
// Set by an inline <a href> tag, cleared by an inline </a>: while set,
// extended autolinks (bare email / www / http / scheme) are suppressed.
// Persists across blocks within one parse() call, like marked's inLink.
let IN_LINK = false;

export function parse(markdown) {
  IN_LINK = false;
  const src = markdown.indexOf('\r') < 0 ? markdown : markdown.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  INPUT_ENDS_WITH_NL = markdown.endsWith('\n') || markdown.endsWith('\r');
  const refs = new Map();
  const blocks = parseBlocks(lines, refs, 0, lines.length, true, true);
  return renderBlocks(blocks, refs, false);
}
export default parse;

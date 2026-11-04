// A small markdown parser for model replies in the chat page.
//
// Model output is untrusted, so this never produces HTML. It turns text into a tree of plain
// objects (paragraphs, headings, lists, code, tables, links...) that chat.js builds into DOM
// nodes with createElement and text nodes. Raw HTML in the text stays visible as text, links
// are kept only for http(s) addresses, and images are shown as their alt text.
//
// Loaded as a plain script in the webview (window.AgenticMarkdown) and with require() in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AgenticMarkdown = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Longer text is cut before parsing, so a huge reply cannot freeze the page. */
  const MAX_INPUT = 200000;
  /** Deepest nesting of quotes and lists, and of bold/italic/links inside each other. */
  const MAX_BLOCK_DEPTH = 8;
  const MAX_INLINE_DEPTH = 6;
  const MAX_TABLE_COLS = 20;
  /** How far ahead a closing marker is searched for, so unclosed markers cannot make parsing slow. */
  const SPAN = 3000;
  /**
   * Work budget for one parse, in characters looked at. Each search for a closing marker is
   * bounded by SPAN, but many unclosed markers ("[[[[...") would each search again, so all
   * searches share this budget. Once it is spent, the rest of the text is shown as plain text.
   */
  const MAX_WORK = 4000000;
  let work = 0;
  const spend = (n) => (work += n) <= MAX_WORK;

  const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
  const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
  const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const QUOTE = /^ {0,3}> ?/;
  const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*)|$)/;
  const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

  // ---- blocks ----

  function parse(text) {
    let t = String(text == null ? "" : text);
    if (t.length > MAX_INPUT) t = t.slice(0, MAX_INPUT) + "\n\n…";
    const lines = t.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
    work = 0;
    return blocks(lines, 0);
  }

  function indentOf(line) {
    return line.length - line.replace(/^ +/, "").length;
  }

  function isBlank(line) {
    return !line || !line.trim();
  }

  function startsBlock(line, next) {
    return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(line, next);
  }

  function isTableStart(line, next) {
    return next !== undefined && line.includes("|") && next.includes("|") && next.includes("-") && TABLE_SEP.test(next);
  }

  function blocks(lines, depth) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        i++;
        continue;
      }
      // Too deep: the rest is shown as plain paragraphs.
      if (depth >= MAX_BLOCK_DEPTH) {
        out.push({ t: "p", c: inline(lines.slice(i).join("\n").trim(), 0) });
        break;
      }
      let m;
      if ((m = FENCE.exec(line))) {
        const pad = m[1].length;
        const mark = m[2];
        const body = [];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
          if (close && close[1][0] === mark[0] && close[1].length >= mark.length) {
            i++;
            break;
          }
          body.push(l.slice(Math.min(pad, indentOf(l))));
          i++;
        }
        out.push({ t: "code", lang: cleanLang(m[3]), text: body.join("\n") });
        continue;
      }
      if ((m = HEADING.exec(line))) {
        const textPart = (m[2] || "").replace(/(^|[ \t]+)#+[ \t]*$/, "");
        out.push({ t: "h", level: m[1].length, c: inline(textPart, 0) });
        i++;
        continue;
      }
      if (HR.test(line)) {
        out.push({ t: "hr" });
        i++;
        continue;
      }
      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ""));
        out.push({ t: "quote", c: blocks(body, depth + 1) });
        continue;
      }
      if (isTableStart(line, lines[i + 1])) {
        const r = table(lines, i);
        out.push(r.node);
        i = r.next;
        continue;
      }
      if (ITEM.test(line)) {
        const r = list(lines, i, depth);
        out.push(r.node);
        i = r.next;
        continue;
      }
      const para = [line.trim()];
      i++;
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim());
      out.push({ t: "p", c: inline(para.join("\n"), 0) });
    }
    return out;
  }

  function cleanLang(s) {
    const l = String(s || "").toLowerCase().replace(/[^a-z0-9_+#.-]/g, "");
    return l.slice(0, 30);
  }

  function itemInfo(line) {
    const m = ITEM.exec(line);
    if (!m) return null;
    const indent = m[1].length;
    const marker = m[2];
    const ordered = /\d/.test(marker);
    const spaces = m[3] ? m[3].length : 1;
    // Many spaces after the marker means code in strict markdown; here it is just text.
    const contentIndent = indent + marker.length + (spaces > 4 ? 1 : spaces);
    return { indent, ordered, delim: ordered ? marker.slice(-1) : marker, start: ordered ? parseInt(marker, 10) : 1, contentIndent, first: m[4] || "" };
  }

  function list(lines, i, depth) {
    const head = itemInfo(lines[i]);
    const items = [];
    let cur = null;
    while (i < lines.length) {
      const line = lines[i];
      const info = itemInfo(line);
      // A marker at (about) the first item's indent starts the next item.
      if (info && info.indent < (cur ? cur.indent + 2 : head.indent + 2) && info.indent >= head.indent - 3) {
        if (info.ordered !== head.ordered || info.delim !== head.delim) break;
        cur = { indent: info.indent, contentIndent: info.contentIndent, lines: [info.first] };
        items.push(cur);
        i++;
        continue;
      }
      if (isBlank(line)) {
        // A blank line stays in the list only if the list goes on after it.
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j >= lines.length) break;
        const nextInfo = itemInfo(lines[j]);
        const continues = indentOf(lines[j]) >= cur.contentIndent || (nextInfo && nextInfo.indent < cur.indent + 2 && nextInfo.ordered === head.ordered && nextInfo.delim === head.delim);
        if (!continues) break;
        for (; i < j; i++) cur.lines.push("");
        continue;
      }
      const ind = indentOf(line);
      if (ind >= cur.indent + 2) {
        cur.lines.push(line.slice(Math.min(ind, cur.contentIndent)));
        i++;
        continue;
      }
      // Lazy continuation of the item's paragraph.
      const prev = cur.lines[cur.lines.length - 1];
      if (!isBlank(prev) && !startsBlock(line, lines[i + 1])) {
        cur.lines.push(line.trim());
        i++;
        continue;
      }
      break;
    }
    return {
      node: { t: "list", ordered: head.ordered, start: head.start, items: items.map((it) => blocks(it.lines, depth + 1)) },
      next: i,
    };
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    const cells = [];
    let cell = "";
    let inCode = 0;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (ch === "\\" && s[k + 1] === "|") {
        cell += "|";
        k++;
      } else if (ch === "`") {
        let n = 1;
        while (s[k + n] === "`") n++;
        if (!inCode) inCode = n;
        else if (inCode === n) inCode = 0;
        cell += s.slice(k, k + n);
        k += n - 1;
      } else if (ch === "|" && !inCode) {
        cells.push(cell.trim());
        cell = "";
      } else cell += ch;
    }
    cells.push(cell.trim());
    return cells.slice(0, MAX_TABLE_COLS);
  }

  function table(lines, i) {
    const head = splitRow(lines[i]);
    const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
    const cols = head.length;
    const rows = [];
    i += 2;
    while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
      const cells = splitRow(lines[i]);
      const row = [];
      for (let k = 0; k < cols; k++) row.push(inline(cells[k] || "", 0));
      rows.push(row);
      i++;
    }
    return {
      node: { t: "table", align: head.map((_, k) => align[k] || ""), head: head.map((c) => inline(c, 0)), rows },
      next: i,
    };
  }

  // ---- inline ----

  const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
  const WORD = /[\p{L}\p{N}]/u;

  /** Returns an http(s) address, or null for anything else (javascript:, file:, command:, data:...). */
  function safeUrl(raw) {
    const s = String(raw || "").trim();
    if (!/^https?:\/\//i.test(s) || s.length > 2000) return null;
    if (/[\s<>"'`\u0000-\u001f\u007f]/.test(s)) return null;
    try {
      const u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      if (u.username || u.password) return null;
      return u.href;
    } catch {
      return null;
    }
  }

  function inline(text, depth) {
    const out = [];
    let buf = "";
    const flush = () => {
      if (buf) out.push({ t: "text", v: buf });
      buf = "";
    };
    const push = (node) => {
      flush();
      out.push(node);
    };
    const s = String(text);
    if (depth >= MAX_INLINE_DEPTH) return s ? [{ t: "text", v: s }] : [];
    let i = 0;
    while (i < s.length) {
      if (!spend(1)) {
        buf += s.slice(i);
        break;
      }
      const ch = s[i];
      if (ch === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1])) {
        buf += s[i + 1];
        i += 2;
        continue;
      }
      if (ch === "\n") {
        // Line breaks inside a paragraph are kept: models use them as breaks.
        buf = buf.replace(/ +$/, "").replace(/\\$/, "");
        push({ t: "br" });
        i++;
        continue;
      }
      if (ch === "`") {
        let n = 1;
        while (s[i + n] === "`") n++;
        const fence = "`".repeat(n);
        let j = i + n;
        let end = -1;
        while ((j = find(s, fence, j, i + SPAN)) !== -1) {
          if (s[j + n] !== "`" && s[j - 1] !== "`") {
            end = j;
            break;
          }
          j += n;
        }
        if (end !== -1) {
          let v = s.slice(i + n, end).replace(/\n/g, " ");
          if (/^ .* $/.test(v) && v.trim()) v = v.slice(1, -1);
          push({ t: "code", v });
          i = end + n;
          continue;
        }
        buf += fence;
        i += n;
        continue;
      }
      if (ch === "!" && s[i + 1] === "[") {
        const l = link(s, i + 1);
        if (l) {
          // Images are never loaded; the alt text stands in for them.
          buf += l.label;
          i = l.end;
          continue;
        }
      }
      if (ch === "[") {
        const l = link(s, i);
        if (l) {
          const href = safeUrl(l.url);
          if (href) push({ t: "link", href, c: inline(l.label, depth + 1) });
          else out.push(...flushAnd(inline(l.label, depth + 1)));
          i = l.end;
          continue;
        }
      }
      if (ch === "<") {
        const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(s.slice(i, i + 2100));
        const href = m && safeUrl(m[1]);
        if (href) {
          push({ t: "link", href, c: [{ t: "text", v: m[1] }] });
          i += m[0].length;
          continue;
        }
      }
      if ((ch === "h" || ch === "H") && (i === 0 || !WORD.test(s[i - 1]))) {
        const m = /^https?:\/\/[^\s<>`]+/i.exec(s.slice(i, i + 2100));
        if (m) {
          let u = m[0].replace(/[.,:;!?'"*_~]+$/, "");
          // Keep a closing parenthesis only when the address opened one.
          while (u.endsWith(")") && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1);
          const href = safeUrl(u);
          if (href) {
            push({ t: "link", href, c: [{ t: "text", v: u }] });
            i += u.length;
            continue;
          }
        }
      }
      if (ch === "*" || ch === "_" || ch === "~") {
        const r = emphasis(s, i, depth);
        if (r) {
          push(r.node);
          i = r.end;
          continue;
        }
        // A run of the same marker that does not open anything stays as text.
        let n = 1;
        while (s[i + n] === ch) n++;
        buf += s.slice(i, i + n);
        i += n;
        continue;
      }
      buf += ch;
      i++;
    }
    flush();
    return out;

    function flushAnd(nodes) {
      flush();
      return nodes;
    }
  }

  function emphasis(s, i, depth) {
    const ch = s[i];
    let n = 1;
    while (s[i + n] === ch) n++;
    const before = i > 0 ? s[i - 1] : " ";
    const after = s[i + n];
    if (after === undefined || /\s/.test(after)) return null;
    // snake_case and 2*3*4 stay as they are.
    if (ch === "_" && WORD.test(before)) return null;
    let size;
    let type;
    if (ch === "~") {
      if (n !== 2) return null;
      size = 2;
      type = "del";
    } else if (n >= 3) {
      size = 3;
      type = "strongem";
    } else {
      size = n;
      type = n === 2 ? "strong" : "em";
    }
    const mark = ch.repeat(size);
    let j = i + size;
    while ((j = find(s, mark, j, i + SPAN)) !== -1) {
      const prev = s[j - 1];
      const next = s[j + size];
      const okClose = prev !== undefined && !/\s/.test(prev) && next !== ch && (ch !== "_" || next === undefined || !WORD.test(next));
      if (okClose && j > i + size) {
        // A code span between the markers wins over the emphasis.
        const inner = s.slice(i + size, j);
        if (!spend(inner.length) || (inner.match(/`/g) || []).length % 2 === 1) return null;
        const c = inline(inner, depth + 1);
        const node = type === "strongem" ? { t: "strong", c: [{ t: "em", c }] } : { t: type, c };
        return { node, end: j + size };
      }
      j += size;
      while (s[j] === ch) j++;
    }
    return null;
  }

  /** indexOf within s[from, limit), charged to the work budget. */
  function find(s, needle, from, limit) {
    const end = Math.min(s.length, limit);
    if (from >= end) return -1;
    const k = s.slice(0, end).indexOf(needle, from);
    spend((k === -1 ? end : k) - from + 1);
    return k;
  }

  /** Reads [label](url) at s[i] === "[". */
  function link(s, i) {
    let depth = 0;
    let j = i;
    const stop = Math.min(s.length, i + SPAN);
    for (; j < stop; j++) {
      if (!spend(1)) return null;
      const c = s[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "`") {
        const close = find(s, "`", j + 1, stop);
        if (close !== -1) j = close;
        continue;
      }
      if (c === "[") depth++;
      else if (c === "]" && --depth === 0) break;
      if (c === "\n" && s[j + 1] === "\n") return null;
    }
    if (j >= stop || s[j + 1] !== "(" || !spend(200)) return null;
    const m = /^\(\s*<?([^\s()<>]*(?:\([^\s()<>]*\)[^\s()<>]*)*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(s.slice(j + 1, j + 2200));
    if (!m) return null;
    return { label: s.slice(i + 1, j), url: m[1], end: j + 1 + m[0].length };
  }

  /** The plain text of a tree, for tests and for titles. */
  function plainText(nodes) {
    return (nodes || [])
      .map((n) => {
        if (n.t === "text" || n.t === "code") return n.v !== undefined ? n.v : n.text;
        if (n.t === "br") return "\n";
        if (n.c) return plainText(n.c);
        if (n.items) return n.items.map(plainText).join("\n");
        return "";
      })
      .join("");
  }

  return {
    parse,
    inline: (t) => {
      work = 0;
      return inline(t, 0);
    },
    safeUrl,
    plainText,
    MAX_WORK,
  };
});

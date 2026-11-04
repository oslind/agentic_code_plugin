// A small syntax highlighter for code blocks in model replies.
//
// It only splits code into tokens ({ k: kind, v: text }); chat.js puts each token in a <span>
// with a fixed class and the text as a text node. Joining the tokens always gives back the
// exact code, so highlighting can never hide or change what the model wrote.
//
// Loaded as a plain script in the webview (window.AgenticHighlight) and with require() in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AgenticHighlight = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Larger blocks are shown without colors, so a huge reply stays fast. */
  const MAX_CODE = 60000;
  /** Token kinds; chat.js maps each to a "tok-<kind>" class. */
  const KINDS = ["comment", "string", "number", "keyword", "literal", "type", "function", "property", "operator", "punct", "variable", "tag", "attr", "meta", "deleted", "inserted", "heading"];

  const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

  const C_LIKE_KW = words(`
    abstract as async await break case catch class const continue debugger default delete do else enum export extends
    final finally for from function get if implements import in instanceof interface let module namespace new of package
    private protected public readonly return set static super switch this throw try type typeof var void while with yield
    declare keyof infer satisfies override
    fn impl mut pub use mod struct trait where match loop move ref crate self Self dyn unsafe extern
    func go defer chan map range select fallthrough goto
    using virtual template typename operator friend inline volatile register sizeof struct union constexpr noexcept
    val var fun object data sealed when is internal companion lateinit
    def lambda`);
  const C_LIKE_LIT = words("true false null undefined NaN Infinity nil None True False");
  const C_LIKE_TYPES = words("string number boolean any unknown never object bigint symbol int long short char byte float double bool usize isize u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 str");

  const PY_KW = words(`
    and as assert async await break class continue def del elif else except finally for from global if import in is
    lambda nonlocal not or pass raise return try while with yield match case print`);
  const PY_LIT = words("True False None self cls");

  const SH_KW = words("if then else elif fi for while until do done case esac in function return exit export local readonly unset shift break continue select time");
  const SH_BUILTIN = words("echo cd ls cat grep sed awk rm cp mv mkdir touch chmod chown npm npx node yarn pnpm git python python3 pip pip3 curl wget make sudo source set test printf read kill ps docker cargo go rustc tsc vsce code");

  const SQL_KW = words(`
    select from where and or not insert into values update set delete create table drop alter add column index primary key
    foreign references join left right inner outer full on group by order having limit offset as distinct union all exists
    in is null like between case when then else end begin commit rollback view returning default unique check`);

  const LANG = {
    js: "c", javascript: "c", jsx: "c", mjs: "c", cjs: "c", ts: "c", typescript: "c", tsx: "c", mts: "c", cts: "c",
    java: "c", c: "c", h: "c", cpp: "c", "c++": "c", cc: "c", hpp: "c", cs: "c", "c#": "c", csharp: "c", go: "c", golang: "c",
    rust: "c", rs: "c", kotlin: "c", kt: "c", swift: "c", scala: "c", dart: "c", php: "c", groovy: "c", gradle: "c",
    py: "py", python: "py", python3: "py", rb: "py", ruby: "py",
    sh: "sh", bash: "sh", zsh: "sh", shell: "sh", console: "sh", shellsession: "sh", ps: "sh", powershell: "sh", ps1: "sh", bat: "sh", cmd: "sh", dockerfile: "sh", docker: "sh", makefile: "sh", make: "sh",
    json: "json", jsonc: "json", json5: "json",
    yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml", properties: "yaml", env: "yaml", conf: "yaml",
    html: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup", xhtml: "markup", plist: "markup",
    css: "css", scss: "css", sass: "css", less: "css",
    sql: "sql", postgres: "sql", mysql: "sql", sqlite: "sql",
    diff: "diff", patch: "diff",
    md: "md", markdown: "md",
  };

  /** Display names for the label above a code box. */
  const LABEL = { js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", jsx: "JSX", py: "Python", python: "Python", sh: "Shell", bash: "Bash", zsh: "Zsh", shell: "Shell", json: "JSON", yaml: "YAML", yml: "YAML", html: "HTML", xml: "XML", css: "CSS", scss: "SCSS", sql: "SQL", diff: "Diff", md: "Markdown", markdown: "Markdown", go: "Go", rust: "Rust", rs: "Rust", java: "Java", c: "C", cpp: "C++", cs: "C#", csharp: "C#", kotlin: "Kotlin", kt: "Kotlin", swift: "Swift", rb: "Ruby", ruby: "Ruby", php: "PHP", toml: "TOML", ini: "INI", powershell: "PowerShell", ps1: "PowerShell", dockerfile: "Dockerfile", makefile: "Makefile" };

  function family(lang) {
    return LANG[String(lang || "").toLowerCase()] || null;
  }

  function label(lang) {
    const l = String(lang || "").toLowerCase();
    return LABEL[l] || (l ? l : "");
  }

  /** Runs sticky-regex rules over the code; text no rule matches becomes plain. */
  function scan(code, rules, classify) {
    const out = [];
    let plain = "";
    let i = 0;
    const push = (k, v) => {
      if (!v) return;
      if (k === null) {
        plain += v;
        return;
      }
      if (plain) out.push({ k: null, v: plain });
      plain = "";
      const last = out[out.length - 1];
      if (last && last.k === k) last.v += v;
      else out.push({ k, v });
    };
    outer: while (i < code.length) {
      for (const [re, kind] of rules) {
        re.lastIndex = i;
        const m = re.exec(code);
        if (m && m[0].length) {
          const k = typeof kind === "function" ? kind(m, code, i) : kind;
          if (Array.isArray(k)) for (const [kk, vv] of k) push(kk, vv);
          else push(classify && k === "ident" ? classify(m[0], code, i + m[0].length, out) : k, m[0]);
          i += m[0].length;
          continue outer;
        }
      }
      push(null, code[i]);
      i++;
    }
    if (plain) out.push({ k: null, v: plain });
    return out;
  }

  const NUM = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z]{0,3}\b/y;
  const IDENT = /[A-Za-z_$][\w$]*/y;
  const OPS = /[+\-*/%=!<>&|^~?:]+/y;
  const PUNCT = /[{}()[\];,.@#\\]/y;
  const WS = /\s+/y;

  function nextNonSpace(code, j) {
    while (j < code.length && /\s/.test(code[j])) j++;
    return code[j];
  }

  function prevToken(out) {
    for (let k = out.length - 1; k >= 0; k--) if (out[k].k !== null || out[k].v.trim()) return out[k];
    return null;
  }

  function cLike(code) {
    const rules = [
      [WS, null],
      [/\/\/[^\n]*/y, "comment"],
      [/\/\*[\s\S]*?(?:\*\/|$)/y, "comment"],
      [/`(?:[^`\\]|\\[\s\S])*`?/y, "string"],
      [/"(?:[^"\\\n]|\\.)*"?/y, "string"],
      [/'(?:[^'\\\n]|\\.)*'?/y, "string"],
      [/@[A-Za-z_]\w*/y, "meta"],
      [/#\s*(?:include|define|if|ifdef|ifndef|endif|else|elif|pragma|undef)\b[^\n]*/y, "meta"],
      [NUM, "number"],
      [IDENT, "ident"],
      [OPS, "operator"],
      [PUNCT, "punct"],
    ];
    return scan(code, rules, (w, src, end, out) => {
      if (C_LIKE_LIT.has(w)) return "literal";
      if (C_LIKE_KW.has(w)) return "keyword";
      if (C_LIKE_TYPES.has(w)) return "type";
      const prev = prevToken(out);
      if (nextNonSpace(src, end) === "(") return "function";
      if (/^[A-Z][a-z0-9]/.test(w) || /^[A-Z]$/.test(w)) return "type";
      if (prev && prev.v.endsWith(".")) return "property";
      return null;
    });
  }

  function python(code) {
    const rules = [
      [WS, null],
      [/#[^\n]*/y, "comment"],
      [/[rRbBfFuU]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/y, "string"],
      [/[rRbBfFuU]{0,2}(?:"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)/y, "string"],
      [/@[A-Za-z_][\w.]*/y, "meta"],
      [NUM, "number"],
      [IDENT, "ident"],
      [OPS, "operator"],
      [PUNCT, "punct"],
    ];
    return scan(code, rules, (w, src, end, out) => {
      if (PY_LIT.has(w)) return "literal";
      if (PY_KW.has(w)) return "keyword";
      const prev = prevToken(out);
      if (prev && prev.v.endsWith(".")) return nextNonSpace(src, end) === "(" ? "function" : "property";
      if (nextNonSpace(src, end) === "(") return "function";
      if (/^[A-Z][a-z0-9]/.test(w)) return "type";
      return null;
    });
  }

  function shell(code) {
    const rules = [
      [/[ \t]+/y, null],
      [/\n/y, null],
      [/(?<![^\s])#[^\n]*/y, "comment"],
      [/^\s*[$>%]\s(?=\S)/my, "meta"],
      [/"(?:[^"\\]|\\[\s\S])*"?/y, "string"],
      [/'[^']*'?/y, "string"],
      [/\$\{[^}\n]*\}?|\$\(|\$[A-Za-z_]\w*|\$[0-9#?@*$!-]/y, "variable"],
      [/(?<![^\s])--?[A-Za-z0-9][\w-]*=?/y, "attr"],
      [/\b\d+\b/y, "number"],
      [/[A-Za-z_][\w.-]*(?==)/y, "variable"],
      [/[A-Za-z_][\w.\-/]*/y, "ident"],
      [/[|&;<>()]+/y, "operator"],
    ];
    return scan(code, rules, (w, src, end, out) => {
      if (SH_KW.has(w)) return "keyword";
      const prev = prevToken(out);
      const atStart = !prev || /[|&;(]$/.test(prev.v) || prev.k === "keyword" || prev.k === "meta" || /\n\s*$/.test(src.slice(0, end - w.length));
      if (atStart && (SH_BUILTIN.has(w) || /^[a-z][\w.-]*$/.test(w))) return "function";
      return null;
    });
  }

  function json(code) {
    const rules = [
      [WS, null],
      [/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y, "comment"],
      [/"(?:[^"\\\n]|\\.)*"?(?=\s*:)/y, "property"],
      [/"(?:[^"\\\n]|\\.)*"?/y, "string"],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, "number"],
      [/\b(?:true|false|null)\b/y, "literal"],
      [/[{}[\]:,]/y, "punct"],
    ];
    return scan(code, rules);
  }

  function yaml(code) {
    const rules = [
      [/[ \t]+/y, null],
      [/\n/y, null],
      [/#[^\n]*/y, "comment"],
      [/^\s*\[[^\]\n]*\]/my, "heading"],
      [/^\s*-\s/my, "punct"],
      [/[A-Za-z_][\w.\-]*(?=\s*[:=](?:\s|$))/y, "property"],
      [/"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?/y, "string"],
      [/\b(?:true|false|yes|no|on|off|null|~)\b/y, "literal"],
      [/-?\b\d+(?:\.\d+)?\b/y, "number"],
      [/[:=|>{}[\],&*!]/y, "punct"],
    ];
    return scan(code, rules);
  }

  function markup(code) {
    const rules = [
      [/<!--[\s\S]*?(?:-->|$)/y, "comment"],
      [/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/y, "string"],
      [/<![^>]*>?|<\?[\s\S]*?(?:\?>|$)/y, "meta"],
      [
        /<\/?[A-Za-z][\w:.-]*/y,
        (m) => [
          ["punct", m[0].startsWith("</") ? "</" : "<"],
          ["tag", m[0].replace(/^<\/?/, "")],
        ],
      ],
      [/\/?>/y, "punct"],
      [/[A-Za-z_:][\w:.-]*(?==)/y, "attr"],
      [/"[^"]*"?|'[^']*'?/y, "string"],
      [/&[#\w]+;/y, "literal"],
    ];
    return scan(code, rules);
  }

  function css(code) {
    const rules = [
      [WS, null],
      [/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/y, "comment"],
      [/"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?/y, "string"],
      [/@[\w-]+/y, "keyword"],
      [/--[\w-]+|[$@][\w-]+/y, "variable"],
      [/[\w-]+(?=\s*:[^:{;]*[;}])/y, "property"],
      [/#[\da-fA-F]{3,8}\b/y, "number"],
      [/-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch|pt)?\b/y, "number"],
      [/[.#][\w-]+|::?[\w-]+/y, "type"],
      [/[\w-]+(?=\()/y, "function"],
      [/[A-Za-z][\w-]*/y, "tag"],
      [/[{}();:,>+~*=]/y, "punct"],
    ];
    return scan(code, rules);
  }

  function sql(code) {
    const rules = [
      [WS, null],
      [/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y, "comment"],
      [/'(?:[^']|'')*'?/y, "string"],
      [/"[^"\n]*"?|`[^`\n]*`?/y, "property"],
      [NUM, "number"],
      [IDENT, "ident"],
      [/[=<>!+\-*/%|]+/y, "operator"],
      [/[(),;.]/y, "punct"],
    ];
    return scan(code, rules, (w, src, end) => {
      const l = w.toLowerCase();
      if (l === "null" || l === "true" || l === "false") return "literal";
      if (SQL_KW.has(l)) return "keyword";
      if (nextNonSpace(src, end) === "(") return "function";
      return null;
    });
  }

  function diff(code) {
    const out = [];
    for (const line of code.split(/(?<=\n)/)) {
      let k = null;
      if (/^(\+\+\+|---)\s/.test(line) || /^diff /.test(line) || /^index /.test(line)) k = "meta";
      else if (/^@@/.test(line)) k = "heading";
      else if (line.startsWith("+")) k = "inserted";
      else if (line.startsWith("-")) k = "deleted";
      out.push({ k, v: line });
    }
    return out;
  }

  function md(code) {
    const rules = [
      [/^#{1,6}[ \t][^\n]*/my, "heading"],
      [/^\s*(?:[-*+]|\d+[.)])(?=\s)/my, "punct"],
      [/`[^`\n]*`?/y, "string"],
      [/\*\*[^*\n]+\*\*|__[^_\n]+__/y, "keyword"],
      [/\[[^\]\n]*\]\([^)\n]*\)?/y, "attr"],
      [/[^\n#`*_[\-+\d]+|[\s\S]/y, null],
    ];
    return scan(code, rules);
  }

  const BY_FAMILY = { c: cLike, py: python, sh: shell, json, yaml, markup, css, sql, diff, md };

  /** A guess for blocks without a language, from how the code looks. */
  function guess(code) {
    const head = code.slice(0, 2000);
    if (/^\s*[{[]/.test(head) && /"\s*:/.test(head)) return "json";
    if (/^(diff --git|@@ |--- |\+\+\+ )/m.test(head)) return "diff";
    if (/^\s*<[A-Za-z!?]/.test(head)) return "markup";
    if (/^\s*(\$ |npm |npx |cd |git |yarn |pnpm |pip |python3? |node |curl |sudo )/m.test(head)) return "sh";
    if (/^\s*(def |from \S+ import |import \S+$|class \w+(\(.*\))?:)/m.test(head)) return "py";
    if (/\b(const|let|function|return|import|export|interface|class|public|static|void|fn|func)\b/.test(head)) return "c";
    return null;
  }

  /** Splits code into tokens. Joining every token's v gives back the code exactly. */
  function tokens(code, lang) {
    const text = String(code == null ? "" : code);
    if (!text) return [];
    if (text.length > MAX_CODE) return [{ k: null, v: text }];
    const fam = family(lang) || (lang ? null : guess(text));
    const fn = fam && BY_FAMILY[fam];
    if (!fn) return [{ k: null, v: text }];
    try {
      const out = fn(text);
      // Never risk showing something other than the code.
      if (out.map((t) => t.v).join("") !== text) return [{ k: null, v: text }];
      return out.filter((t) => t.v).map((t) => ({ k: KINDS.includes(t.k) ? t.k : null, v: t.v }));
    } catch {
      return [{ k: null, v: text }];
    }
  }

  return { tokens, label, family, KINDS };
});

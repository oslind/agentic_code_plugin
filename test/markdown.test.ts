import { readFileSync } from "fs";
import { createRequire } from "module";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { safeExternalUrl } from "../src/chat/links";

type Node = { t: string; v?: string; c?: Node[]; href?: string; text?: string; lang?: string; level?: number; items?: Node[][]; ordered?: boolean; start?: number; head?: Node[][]; rows?: Node[][][]; align?: string[] };
const md = createRequire(__filename)("../media/markdown.js") as {
  parse(text: string): Node[];
  inline(text: string): Node[];
  safeUrl(url: string): string | null;
  plainText(nodes: Node[]): string;
};

/** Every node type the parser may return. chat.js builds DOM for these only. */
const BLOCKS = new Set(["p", "h", "hr", "code", "quote", "list", "table"]);
const INLINES = new Set(["text", "br", "code", "strong", "em", "del", "link"]);

function walkInline(nodes: Node[], seen: Node[]): void {
  for (const n of nodes) {
    expect(INLINES.has(n.t)).toBe(true);
    seen.push(n);
    if (n.c) walkInline(n.c, seen);
  }
}

function walk(blocks: Node[], seen: Node[] = []): Node[] {
  for (const b of blocks) {
    expect(BLOCKS.has(b.t)).toBe(true);
    seen.push(b);
    if (b.t === "quote") walk(b.c!, seen);
    else if (b.t === "list") b.items!.forEach((it) => walk(it, seen));
    else if (b.t === "table") [...b.head!, ...b.rows!.flat()].forEach((c) => walkInline(c, seen));
    else if (b.c) walkInline(b.c, seen);
  }
  return seen;
}

describe("markdown parser", () => {
  it("parses the coordinator's usual reply shapes", () => {
    const tree = md.parse(
      [
        "This is a **VS Code extension** with `src/extension.ts`.",
        "",
        "**Key Features**",
        "- **Sandbox**: agents stay in the folder",
        "  - nested point",
        "- *Recovery* and ~~git~~",
        "",
        "1. one",
        "2. two",
        "",
        "### Build",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
    );
    expect(tree.map((b) => b.t)).toEqual(["p", "p", "list", "list", "h", "code"]);
    expect(tree[0]!.c!.map((n) => n.t)).toEqual(["text", "strong", "text", "code", "text"]);
    const list = tree[2]!;
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    expect(list.items![0]!.map((b) => b.t)).toEqual(["p", "list"]);
    expect(md.plainText(list.items![1]!)).toBe("Recovery and git");
    expect(tree[3]!.ordered).toBe(true);
    expect(tree[4]!.level).toBe(3);
    expect(tree[5]).toMatchObject({ t: "code", lang: "ts", text: "const x = 1;" });
  });

  it("parses tables with alignment and pipes inside code", () => {
    const [t] = md.parse("| a | b |\n|:--|--:|\n| `x|y` | 2 |\n| 3 |");
    expect(t).toMatchObject({ t: "table", align: ["left", "right"] });
    expect(t!.rows).toHaveLength(2);
    expect(t!.rows![0]![0]![0]).toEqual({ t: "code", v: "x|y" });
    expect(t!.rows![1]![1]).toEqual([]);
  });

  it("leaves snake_case, lone stars and unclosed markers as text", () => {
    expect(md.plainText(md.inline("snake_case_name and a * b and **open"))).toBe("snake_case_name and a * b and **open");
    expect(md.inline("snake_case_name").map((n) => n.t)).toEqual(["text"]);
    expect(md.inline("\\*not em\\*")).toEqual([{ t: "text", v: "*not em*" }]);
  });

  it("keeps raw HTML as visible text", () => {
    const text = '<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a>';
    const nodes = walk(md.parse(text));
    expect(nodes.some((n) => n.t === "link")).toBe(false);
    expect(md.plainText(md.parse(text))).toBe(text);
  });

  it("only links http(s) addresses", () => {
    const bad = ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "vbscript:x", "data:text/html,<b>", "file:///etc/passwd", "command:workbench.action.terminal.new", "vscode://x", "https://user:pw@evil.io", "//evil.io"];
    for (const url of bad) {
      const nodes = walk(md.parse(`[click](${url}) <${url}>`));
      expect(nodes.filter((n) => n.t === "link"), url).toEqual([]);
    }
    const nodes = walk(md.parse("[docs](https://example.com/a_(b)) and https://ok.io/x. and <http://a.b/c>"));
    expect(nodes.filter((n) => n.t === "link").map((n) => n.href)).toEqual(["https://example.com/a_(b)", "https://ok.io/x", "http://a.b/c"]);
  });

  it("shows images as their alt text and never loads them", () => {
    const nodes = walk(md.parse("![logo](https://evil.io/track.png)"));
    expect(nodes.some((n) => n.t === "link")).toBe(false);
    expect(md.plainText(md.parse("![logo](https://evil.io/track.png)"))).toBe("logo");
  });

  it("cleans code block languages, which become an attribute", () => {
    const [b] = md.parse('```ts" onmouseover="x\ncode\n```');
    expect(b!.lang).toMatch(/^[a-z0-9_+#.-]*$/);
  });

  it("copes with deep nesting and huge input without hanging", () => {
    const deep = Array.from({ length: 200 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n");
    expect(() => walk(md.parse(deep))).not.toThrow();
    expect(() => walk(md.parse(">".repeat(500) + " x"))).not.toThrow();
    expect(() => walk(md.parse("**".repeat(5000) + "[".repeat(5000) + "`".repeat(3000)))).not.toThrow();
    const started = Date.now();
    md.parse(("*a _b ~~c [d](e `f\n").repeat(20000));
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("markdown in the page", () => {
  const js = readFileSync(path.join(__dirname, "..", "media", "chat.js"), "utf8");
  const parser = readFileSync(path.join(__dirname, "..", "media", "markdown.js"), "utf8");

  it("never inserts HTML", () => {
    for (const src of [js, parser]) {
      expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/);
    }
  });

  it("gives links no href; the extension opens them after checking", () => {
    expect(js).not.toMatch(/["']?href["']?\s*:/);
    expect(js).toContain('post({ type: "openLink", url })');
  });
});

describe("safeExternalUrl", () => {
  it("accepts only plain http(s) addresses", () => {
    expect(safeExternalUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    for (const bad of ["javascript:alert(1)", "command:x", "file:///x", "vscode://x", "https://u:p@x.io", "https://x.io/ a", 42, undefined, "x".repeat(3000)]) {
      expect(safeExternalUrl(bad)).toBeUndefined();
    }
  });
});

describe("one-line previews", () => {
  it("drop markdown marks", async () => {
    const { stripMarkdown } = await import("../src/chat/dashboard");
    expect(stripMarkdown("This is a **VS Code extension** with `src/x.ts`.\n\n**Key Features**\n- **Sandbox**: [docs](https://a.b)\n### Build").replace(/\s+/g, " ").trim()).toBe(
      "This is a VS Code extension with src/x.ts. Key Features Sandbox: docs Build",
    );
    expect(stripMarkdown("snake_case_name and 2 * 3")).toBe("snake_case_name and 2 * 3");
  });
});

describe("code highlighting", () => {
  const hl = createRequire(__filename)("../media/highlight.js") as { tokens(code: string, lang?: string): { k: string | null; v: string }[]; label(lang: string): string; KINDS: string[] };
  const kinds = (code: string, lang?: string) => hl.tokens(code, lang).filter((t) => t.k).map((t) => `${t.k}:${t.v.trim()}`);

  const samples: [string, string][] = [
    ["ts", 'export function activate(ctx: vscode.ExtensionContext): void {\n  // start\n  const n = 42; const s = `x ${n}`;\n  ctx.subscriptions.push(new Foo("a\\"b"));\n}'],
    ["py", 'def f(x):\n    """doc"""\n    return x + 1  # one\n@deco\nclass A(B): pass'],
    ["bash", "$ npm run compile && echo \"done $HOME\" # build\nexport FOO=1\ngit status --short"],
    ["json", '{"name": "agentic", "n": 1.5, "ok": true, "x": null}'],
    ["yaml", "name: test\non: [push]\n# c\nkey: 'v'"],
    ["html", '<div class="a">&amp; <!-- c --><b>x</b></div>'],
    ["css", ".md a:hover { color: #fff; margin: 2px; }"],
    ["sql", "SELECT id, name FROM users WHERE id = 'x' -- c"],
    ["diff", "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new"],
    ["", "const x = 1;"],
    ["brainfuck", "+++[>++<-]"],
    ["ts", "unterminated `template and /* comment and \"string"],
  ];

  it("always gives back the exact code", () => {
    for (const [lang, code] of samples) expect(hl.tokens(code, lang).map((t) => t.v).join(""), lang).toBe(code);
    const weird = "\u0000<script>‮`'\"/*#--@@<!--" + "x".repeat(70000);
    expect(hl.tokens(weird, "ts").map((t) => t.v).join("")).toBe(weird);
  });

  it("only uses known token kinds", () => {
    for (const [lang, code] of samples) for (const t of hl.tokens(code, lang)) expect(t.k === null || hl.KINDS.includes(t.k)).toBe(true);
  });

  it("colors the usual parts", () => {
    const ts = kinds(samples[0]![1], "ts");
    expect(ts).toEqual(expect.arrayContaining(["keyword:export", "keyword:function", "function:activate", "type:ExtensionContext", "comment:// start", "number:42", "keyword:new", "function:push", "property:subscriptions"]));
    expect(kinds(samples[1]![1], "py")).toEqual(expect.arrayContaining(["keyword:def", "comment:# one", 'string:"""doc"""', "meta:@deco"]));
    expect(kinds(samples[2]![1], "bash")).toEqual(expect.arrayContaining(["function:npm", "comment:# build", "attr:--short"]));
    expect(kinds(samples[3]![1], "json")).toEqual(expect.arrayContaining(['property:"name"', 'string:"agentic"', "literal:true", "number:1.5"]));
    expect(kinds(samples[5]![1], "html")).toEqual(expect.arrayContaining(["tag:div", "attr:class", "comment:<!-- c -->"]));
    expect(kinds(samples[8]![1], "diff")).toEqual(expect.arrayContaining(["inserted:+new", "deleted:-old"]));
    expect(kinds(samples[9]![1])).toContain("keyword:const");
    expect(kinds(samples[10]![1], "brainfuck")).toEqual([]);
    expect(hl.label("ts")).toBe("TypeScript");
  });

  it("is used by the page as spans with text, nothing else", () => {
    const js = readFileSync(path.join(__dirname, "..", "media", "chat.js"), "utf8");
    const src = readFileSync(path.join(__dirname, "..", "media", "highlight.js"), "utf8");
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.|eval\(|new Function/);
    expect(js).toContain('el("span", { class: "tok-" + t.k }, t.v)');
  });
});

describe("one-line previews of code", () => {
  it("name a code block instead of flattening it", async () => {
    const { stripMarkdown } = await import("../src/chat/dashboard");
    expect(stripMarkdown("Here it is:\n\n```ts\nconst x = 1;\n```\nDone.").replace(/\s+/g, " ").trim()).toBe("Here it is: [code] Done.");
    expect(stripMarkdown("Open:\n```\nnever closed").replace(/\s+/g, " ").trim()).toBe("Open: [code]");
  });
});

/**
 * Command output and command lines come from the project, so they are
 * untrusted: a test could print escape sequences that clear the screen,
 * redraw it with "all passed", add links, or send VS Code's shell-integration
 * markers. Before anything reaches the terminal, it goes through this filter.
 * What gets through: printable text, tabs, line breaks and plain colors and
 * styles (SGR). Everything else is removed (escape sequences, OSC/DCS strings)
 * or shown as visible text (other control characters, text-direction marks).
 */

/**
 * SGR codes that keep text readable: weight, italic, underline, strike-through
 * and the 16 theme foreground colors, plus the codes that switch styles off.
 * Left out, so output cannot make text invisible or blend into the background:
 * concealed (8), blinking (5, 6), reverse video (7), every background color
 * (40-47, 100-107, 48;...) and 256-color or RGB colors (38;5;n, 38;2;r;g;b),
 * which could pick exactly the terminal's background. The 16 theme colors are
 * the theme's own palette, and VS Code keeps them readable on its background
 * (terminal.integrated.minimumContrastRatio).
 */
const SAFE_SGR = new Set([0, 1, 2, 3, 4, 9, 21, 22, 23, 24, 27, 29, 39, 49]);

function safeSgrCode(n: number): boolean {
  return SAFE_SGR.has(n) || (n >= 30 && n <= 37) || (n >= 90 && n <= 97);
}

/** Keeps the allowed parts of an SGR parameter list, or returns undefined when nothing is left. */
function filterSgr(params: string): string | undefined {
  if (params === "") return "0";
  const nums = params.split(";").map((p) => (p === "" ? 0 : Number(p)));
  const kept: number[] = [];
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i]!;
    if (n === 38 || n === 48 || n === 58) {
      // Extended color: dropped with its arguments, so they are not read as codes of their own.
      if (nums[i + 1] === 5) i += 2;
      else if (nums[i + 1] === 2) i += 4;
      else break;
    } else if (safeSgrCode(n)) {
      kept.push(n);
    }
  }
  return kept.length ? kept.join(";") : undefined;
}

/** Text-direction controls can make text read differently from what is printed (e.g. "Trojan Source"). */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/;

/** How a control character the terminal must not act on is shown instead. */
export function visibleControl(ch: string): string {
  const c = ch.codePointAt(0)!;
  if (c < 0x20) return `^${String.fromCharCode(c + 0x40)}`;
  if (c === 0x7f) return "^?";
  return `<U+${c.toString(16).toUpperCase().padStart(4, "0")}>`;
}

function isControl(c: number): boolean {
  return c < 0x20 || (c >= 0x7f && c <= 0x9f);
}

/**
 * For one line of trusted layout around untrusted text, such as the command
 * in the header: every control character, line break included, is shown as
 * text, so the value stays on its line and cannot style or move anything.
 */
export function escapeTerminalLine(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    out += isControl(c) || BIDI.test(ch) ? visibleControl(ch) : ch;
  }
  return out;
}

/** Like escapeTerminalLine, but keeps line breaks as terminal line breaks. */
export function escapeTerminalText(text: string): string {
  return text
    .split(/\r?\n|\r/)
    .map(escapeTerminalLine)
    .join("\r\n");
}

type State = "ground" | "esc" | "csi" | "string" | "stringEsc";

/** Longest escape sequence kept while it is being read; longer ones are dropped. */
const MAX_SEQUENCE = 64;
/** An OSC/DCS string that never ends stops hiding output after this many characters. */
const MAX_STRING = 4096;

/**
 * Filters a stream of command output for the terminal. It keeps state between
 * chunks, since an escape sequence or a \r\n can be split across two of them.
 */
export class TerminalSanitizer {
  private state: State = "ground";
  private seq = "";
  private skipped = 0;
  private pendingCr = false;

  write(chunk: string): string {
    let out = "";
    for (const ch of chunk) out += this.char(ch);
    return out;
  }

  /** Ends the stream: an unfinished sequence is dropped and a lone \r becomes a line break. */
  end(): string {
    const out = this.pendingCr ? "\r\n" : "";
    this.reset();
    this.pendingCr = false;
    return out;
  }

  private reset(): void {
    this.state = "ground";
    this.seq = "";
    this.skipped = 0;
  }

  private char(ch: string): string {
    const c = ch.codePointAt(0)!;
    switch (this.state) {
      case "esc":
        return this.escChar(ch, c);
      case "csi":
        return this.csiChar(ch, c);
      case "string":
        // Discarded up to its terminator: BEL, ESC \ or ST.
        if (c === 0x07 || c === 0x9c) this.reset();
        else if (c === 0x1b) this.state = "stringEsc";
        else if (++this.skipped > MAX_STRING) this.reset();
        return "";
      case "stringEsc":
        if (ch === "\\") this.reset();
        else this.state = "string";
        return "";
      default:
        return this.ground(ch, c);
    }
  }

  private ground(ch: string, c: number): string {
    let prefix = "";
    if (this.pendingCr) {
      this.pendingCr = false;
      // \r\n is a line break; a lone \r would let output overwrite its own line, so it becomes one too.
      if (c === 0x0a) return "\r\n";
      prefix = "\r\n";
    }
    if (c === 0x0d) {
      this.pendingCr = true;
      return prefix;
    }
    if (c === 0x0a) return `${prefix}\r\n`;
    if (c === 0x09) return `${prefix}\t`;
    if (c === 0x1b) {
      this.state = "esc";
      this.seq = ch;
      return prefix;
    }
    // 8-bit forms: CSI is read (and checked) like ESC [; DCS, SOS, OSC, PM and APC strings are dropped.
    if (c === 0x9b) {
      this.state = "csi";
      this.seq = "\x1b[";
      return prefix;
    }
    if (c === 0x90 || c === 0x98 || c === 0x9d || c === 0x9e || c === 0x9f) {
      this.state = "string";
      return prefix;
    }
    if (isControl(c) || BIDI.test(ch)) return prefix + visibleControl(ch);
    return prefix + ch;
  }

  private escChar(ch: string, c: number): string {
    if (ch === "[") {
      this.state = "csi";
      this.seq += ch;
      return "";
    }
    if (ch === "]" || ch === "P" || ch === "X" || ch === "^" || ch === "_") {
      this.state = "string";
      this.seq = "";
      return "";
    }
    // Intermediate bytes (ESC ( B and the like) belong to the sequence; a final byte ends it. Either way, nothing is shown.
    if (c >= 0x20 && c <= 0x2f && this.seq.length < MAX_SEQUENCE) {
      this.seq += ch;
      return "";
    }
    this.reset();
    if (c >= 0x30 && c <= 0x7e) return "";
    // Not an escape sequence after all (a control character or other text): handle it on its own.
    return this.ground(ch, c);
  }

  private csiChar(ch: string, c: number): string {
    if (c >= 0x20 && c <= 0x3f) {
      this.seq += ch;
      if (this.seq.length > MAX_SEQUENCE) this.reset();
      return "";
    }
    const seq = this.seq;
    this.reset();
    if (c >= 0x40 && c <= 0x7e) {
      // Only colors and styles get through; cursor moves, clears, scrolling and the rest are dropped.
      const params = seq.slice(2);
      if (ch === "m" && /^[0-9;]*$/.test(params)) {
        const kept = filterSgr(params);
        return kept === undefined ? "" : `\x1b[${kept}m`;
      }
      return "";
    }
    return this.ground(ch, c);
  }
}

/** The whole of a piece of untrusted output, made safe for the terminal. */
export function toTerminalText(text: string): string {
  const s = new TerminalSanitizer();
  return s.write(text) + s.end();
}

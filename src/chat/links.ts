/**
 * A link from a markdown reply, as the page sends it back. Only plain http(s) addresses
 * without user info are opened; anything else (javascript:, command:, file:, vscode:...) is dropped.
 */
export function safeExternalUrl(x: unknown): string | undefined {
  // eslint-disable-next-line no-control-regex
  if (typeof x !== "string" || x.length > 2000 || /[\s<>"'`\u0000-\u001f\u007f]/.test(x)) return undefined;
  let u: URL;
  try {
    u = new URL(x);
  } catch {
    return undefined;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || !u.hostname) return undefined;
  return u.href;
}

/** What the confirmation before opening a link shows: the real host and why it may be unexpected. */
export interface LinkCheck {
  url: string;
  host: string;
  warnings: string[];
}

function ipv4Parts(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : undefined;
}

/** Loopback, private, link-local and other addresses that are not on the public internet. */
function localIpv4(p: number[]): boolean {
  const [a = 0, b = 0] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function localIpv6(h: string): boolean {
  const x = h.toLowerCase();
  if (x === "::1" || x === "::") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) {
    const p = ipv4Parts(mapped[1]!);
    return !p || localIpv4(p);
  }
  if (x.startsWith("::ffff:")) return true;
  return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff");
}

/**
 * Checks a link from a model reply before it is opened. The link text in the reply is written by
 * the model, so the confirmation shows the real destination and warns about local or private
 * addresses (a prompt-injected link could target a service on this machine or network), raw IP
 * addresses, look-alike (punycode) names, unusual ports and unencrypted http.
 */
export function checkLink(x: unknown): LinkCheck | undefined {
  const url = safeExternalUrl(x);
  if (!url) return undefined;
  const u = new URL(url);
  const raw = u.hostname;
  const host = raw.replace(/^\[|\]$/g, "");
  const warnings: string[] = [];
  const v4 = ipv4Parts(host);
  const v6 = host.includes(":");
  const lower = host.toLowerCase().replace(/\.$/, "");
  if (lower === "localhost" || lower.endsWith(".localhost") || (v4 && localIpv4(v4)) || (v6 && localIpv6(host))) {
    warnings.push("This is an address on your own computer or local network, not a public website. A link like this can reach services running on your machine or router.");
  } else if (/\.(local|lan|internal|intranet|corp|home|home\.arpa)$/.test(lower) || (!v4 && !v6 && !lower.includes("."))) {
    warnings.push("This looks like a name on a local or company network, not a public website.");
  } else if (v4 || v6) {
    warnings.push("This link goes to a raw IP address instead of a website name.");
  }
  if (lower.split(".").some((label) => label.startsWith("xn--"))) {
    warnings.push("The site name uses international characters (it is shown here in its encoded form), which can imitate a familiar name.");
  }
  if (u.port) warnings.push(`It uses an unusual port (${u.port}).`);
  if (u.protocol === "http:") warnings.push("The connection is not encrypted (http).");
  return { url, host: raw, warnings };
}

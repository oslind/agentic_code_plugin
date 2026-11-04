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

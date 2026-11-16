/**
 * A text check on check commands that refuses ones that obviously point
 * outside the project (absolute paths, `..`, `~`, variables, sudo/ssh).
 *
 * It is NOT a sandbox. Commands start in the project folder, but they run as
 * the user with the user's environment: `python -c ...`, `node -e ...`,
 * `curl`, or any script in the project can read other files and use the
 * network, and this check cannot see what they do. The real protection is
 * that every command waits for the user's approval unless the user turned
 * on "Run commands" in their own settings.
 */
/**
 * What an approval says about any command, truthfully (audit of PR #54): the scratch copy keeps pending changes
 * apart from the user's files, but it is not a sandbox. A command runs as the user and can change real files.
 */
export const COMMAND_RISK_PLAIN =
  "It is not sandboxed: like any command it runs as you, so it can read and change files anywhere your account can, your project included, and use the network. Only allow it if you trust it.";
/** The same warning for a command that runs in the scratch copy. Every command approval uses one of the two. */
export const COMMAND_RISK =
  "It runs in a copy of the project that has the pending changes, but that copy is not a sandbox: like any command it runs as you, so it can read and change files anywhere your account can, your project included, and use the network. Only allow it if you trust it.";

export function commandLeavesProject(command: string): string | undefined {
  const raw = command.trim();
  if (!raw) return "The command is empty.";
  if (raw.length > 500) return "The command is too long.";
  if (/[\r\n]/.test(raw)) return "The command must be one line.";
  // Substitutions and variables can expand to any path, e.g. $HOME, $_, $(pwd)/.. or cmd.exe's %USERPROFILE%.
  // ($1 and the like stay allowed: awk '{print $1}' is common and they are not paths in a one-line command.)
  if (/`|\$\(|\$\{|\$[A-Za-z_]|%[A-Za-z_][\w()]+%/.test(raw)) return "Variables, `$(...)` and backticks are not allowed, because they can point outside the project.";
  // Gemini audit MED-5: quotes and backslashes join text in a shell (cat .""./x is cat ../x), so the path checks
  // also look at the command with them taken out.
  const bare = raw.replace(/["'\\]/g, "");
  for (const c of raw === bare ? [raw] : [raw, bare]) {
    const outside = pathLeaves(c);
    if (outside) return outside;
  }
  if (/(^|[\s;&|(])(sudo|su|doas|ssh|scp|rsync|chroot)(\s|$)/.test(bare)) return "This command can reach outside the project.";
  return undefined;
}

/**
 * The path checks of commandLeavesProject. A path starts after a space, `=`, `:`, a quote, a bracket, a shell
 * operator, `,` or `{` (brace expansion: {cat,/etc/passwd}) or `@` (curl -d @/etc/passwd).
 */
function pathLeaves(c: string): string | undefined {
  if (/(^|[\s=:'"(;&|<>,{@[])\.\.(?=$|[\\/\s'";&|<>),}\]])/.test(c)) return "`..` is not allowed, because it leads out of the project.";
  if (/(^|[\s=:'"(;&|<>,{@[])~(?=$|[\\/\s'";&|<>),}\]])/.test(c) || /(^|[\s=:'"(;&|<>,{@[])~[A-Za-z_]/.test(c)) return "`~` (the home folder) is outside the project.";
  // Absolute paths. /dev/null is the one exception, for discarding output.
  const withoutNull = c.replace(/(^|[\s=:'"(;&|<>,{@[])\/dev\/null(?=$|[\s'";&|<>)])/g, "$1");
  if (/(^|[\s=:'"(;&|<>,{@[])\//.test(withoutNull)) return "Absolute paths are not allowed; use paths relative to the project.";
  if (/(^|[\s=:'"(;&|<>,{@[])[A-Za-z]:[\\/]/.test(c) || /(^|[\s'"])\\\\/.test(c)) return "Absolute paths are not allowed; use paths relative to the project.";
  return undefined;
}

/**
 * A last line of defence for shell commands (checks): every command runs with
 * its working directory inside the project, and this refuses commands whose
 * text points outside it. It is a text check, so it cannot see what a script
 * the command starts does; that is why commands need approval unless the user
 * turned on auto-approve.
 */
export function commandLeavesProject(command: string): string | undefined {
  const c = command.trim();
  if (!c) return "The command is empty.";
  if (c.length > 500) return "The command is too long.";
  if (/[\r\n]/.test(c)) return "The command must be one line.";
  // Substitutions and variables can expand to any path, e.g. $HOME or $(pwd)/..
  if (/`|\$\(|\$\{|\$[A-Za-z_]/.test(c)) return "Variables, `$(...)` and backticks are not allowed, because they can point outside the project.";
  if (/(^|[\s=:'"(;&|<>])\.\.(?=$|[\\/\s'";&|<>)])/.test(c)) return "`..` is not allowed, because it leads out of the project.";
  if (/(^|[\s=:'"(;&|<>])~(?=$|[\\/\s'";&|<>)])/.test(c) || /(^|[\s=:'"(;&|<>])~[A-Za-z_]/.test(c)) return "`~` (the home folder) is outside the project.";
  // Absolute paths. /dev/null is the one exception, for discarding output.
  const withoutNull = c.replace(/(^|[\s=:'"(;&|<>])\/dev\/null(?=$|[\s'";&|<>)])/g, "$1");
  if (/(^|[\s=:'"(;&|<>])\//.test(withoutNull)) return "Absolute paths are not allowed; use paths relative to the project.";
  if (/(^|[\s=:'"(;&|<>])[A-Za-z]:[\\/]/.test(c) || /(^|[\s'"])\\\\/.test(c)) return "Absolute paths are not allowed; use paths relative to the project.";
  if (/(^|[\s;&|(])(sudo|su|doas|ssh|scp|rsync|chroot)(\s|$)/.test(c)) return "This command can reach outside the project.";
  return undefined;
}

/** Run 10, already-done: a file written back as it was (only its final newline lost) is not a change. */
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { expect, it } from "vitest";
import { OverlayFiles } from "../src/changes/overlay";
import { WorkspaceSandbox } from "../src/tools/sandbox";

it("a draft that only differs in trailing whitespace at the end is not pending", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "overlay-same-"));
  await fs.writeFile(path.join(root, "a.js"), "const a = 1;\nmodule.exports = { a };\n");
  const overlay = new OverlayFiles(await WorkspaceSandbox.create(root));
  await overlay.writeFile("a.js", "const a = 1;\nmodule.exports = { a };");
  expect(overlay.pending("t")).toEqual([]);
  await overlay.writeFile("a.js", "const a = 2;\nmodule.exports = { a };");
  expect(overlay.pending("t")).toHaveLength(1);
  await fs.rm(root, { recursive: true, force: true });
});

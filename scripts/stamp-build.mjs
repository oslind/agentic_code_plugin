// Writes out/build.json with the time this build was packaged. The chat shows it
// next to the version, so you can tell two VSIX files of the same version apart
// without bumping the version in every change. Run by "vscode:prepublish".
import { mkdirSync, writeFileSync } from "fs";

mkdirSync("out", { recursive: true });
writeFileSync("out/build.json", `${JSON.stringify({ builtAt: new Date().toISOString() })}\n`);

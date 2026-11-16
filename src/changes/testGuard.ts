import { isTestPath } from "../worker/roles";

/** Snapshots, fixtures and test-runner configs: files that decide what the tests check or which tests run. */
const TEST_SUPPORT = [
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  /(^|\/)(fixtures|__fixtures__|testdata|test-data)\//,
  /(^|\/)(vitest|jest|ava|playwright|cypress)\.(config|workspace)\.[\w.]+$/,
  /(^|\/)karma\.conf\.[\w.]+$/,
  /(^|\/)\.mocharc(\.[\w.]+)?$/,
  /(^|\/)(pytest\.ini|conftest\.py|tox\.ini|\.nycrc(\.[\w.]+)?)$/,
];

/** A test file, snapshot, fixture or test-runner config, in any letter case. */
export function isTestLikePath(path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return isTestPath(p) || TEST_SUPPORT.some((re) => re.test(p.toLowerCase()));
}

/**
 * Whether a draft changes an existing test file, snapshot, fixture or test-runner config. Such a draft is never
 * written without the user, whatever the auto-approve switches say. Only new test files are left to the
 * switches. Second audit of PR #55 (F3): telling a weakened test from a refactor by its lines missed a skip
 * wrapper, an early return, a mock, a changed expected value on its own line and more, so every change to an
 * existing one is held instead.
 */
export function isHeldTestChange(path: string, original: string | null): boolean {
  return original !== null && isTestLikePath(path);
}

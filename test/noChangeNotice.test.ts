/** Run 15, old-test-pins-value: a final reply claimed a change from a run that left no draft. */
import { describe, expect, it } from "vitest";
import { withNoChangeNotice, withNotVerifiedNotice } from "../src/chat/runLoop";

describe("withNoChangeNotice", () => {
  const claim = "The night mode adjustment was changed from 3 to 4 degrees in src/thermostat.js.";
  it("says nothing changed when the run left no draft and the reply claims a change", () => {
    expect(withNoChangeNotice(claim, [])).toMatch(/^Nothing in your project was changed in this run: no sub-agent left a draft, so/);
    expect(withNoChangeNotice(claim, [{ status: "rejected" }])).toMatch(/no sub-agent left a draft you kept/);
  });
  it("leaves the reply alone when there are drafts, or no claim", () => {
    expect(withNoChangeNotice(claim, [{ status: "pending" }])).toBe(claim);
    expect(withNoChangeNotice("The tests failed, so nothing was drafted.", [])).toBe("The tests failed, so nothing was drafted.");
  });
});

describe("withNotVerifiedNotice (run 17, validate-input)", () => {
  const reply = "The work is complete for the requested changes. node src/index.js fails with Error: Invalid mode.";
  it("starts a reply for unverified work with that fact", () => {
    expect(withNotVerifiedNotice(reply, { verified: false, missing: ["node src/index.js fails"] })).toMatch(/^This work is not verified as done: 1 thing is still left/);
    expect(withNotVerifiedNotice(reply, { verified: false, missing: ["a", "b"] })).toMatch(/2 things are still left/);
    expect(withNotVerifiedNotice(reply, { verified: false, missing: [], manualReview: true })).toMatch(/check the drafts against your request yourself/);
  });
  it("leaves verified work and runs without verification alone", () => {
    expect(withNotVerifiedNotice(reply, { verified: true, missing: [] })).toBe(reply);
    expect(withNotVerifiedNotice(reply, undefined)).toBe(reply);
  });
});

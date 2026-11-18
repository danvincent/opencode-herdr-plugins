import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { trackerDraft, canSave, writeTrackerInputs } from "./trackers.js";

describe("trackerDraft merges partial legacy settings without crashing", () => {
  it("fills bitbucket/jira defaults when only lists are stored", () => {
    const t = trackerDraft({ trackers: { repositories: ["github", "bitbucket"] } });
    assert.deepEqual(t.repositories, ["github", "bitbucket"]);
    assert.equal(t.bitbucket.workspace, "");
    assert.equal(t.bitbucket.enabled, false);
    assert.equal(t.bitbucket.baseUrl, "");
    assert.equal(t.jira.baseUrl, "");
    assert.equal(t.jira.enabled, false);
    // The dialog's save-path reads must never crash on legacy settings.
    assert.equal(typeof t.bitbucket.workspace, "string");
    assert.equal(typeof t.jira.baseUrl, "string");
  });
  it("handles missing settings entirely", () => {
    const t = trackerDraft(undefined);
    assert.deepEqual(t.repositories, ["github"]);
    assert.deepEqual(t.issues, ["linear"]);
    assert.equal(t.bitbucket.workspace, "");
  });
  it("preserves stored values", () => {
    const t = trackerDraft({
      trackers: {
        repositories: ["github", "bitbucket"], bitbucket: { workspace: "acme", enabled: true, baseUrl: "" },
        issues: ["linear", "jira"], jira: { baseUrl: "https://x.atlassian.net", enabled: true },
      },
    });
    assert.equal(t.bitbucket.workspace, "acme");
    assert.equal(t.bitbucket.enabled, true);
    assert.equal(t.jira.baseUrl, "https://x.atlassian.net");
  });
});

describe("save guard (null draft)", () => {
  it("a null draft cannot save", () => {
    assert.equal(canSave(null), false);
    assert.equal(canSave(undefined), false);
    assert.equal(canSave({}), false);
  });
  it("a loaded draft can save", () => {
    assert.equal(canSave({ trackers: trackerDraft({}) }), true);
  });
  it("writeTrackerInputs trims inputs and keeps stored flags", () => {
    const t = writeTrackerInputs(trackerDraft({}), { workspace: "  acme ", bbBase: " ", jiraBase: " https://x.atlassian.net " });
    assert.equal(t.bitbucket.workspace, "acme");
    assert.equal(t.bitbucket.baseUrl, "");
    assert.equal(t.jira.baseUrl, "https://x.atlassian.net");
  });
});

// Pure tracker-draft helpers for the settings dialog: no UI imports, so
// plain node can test them. The single source of tracker defaults is
// withDefaults in cc-status/settings.js; nothing here duplicates it.
import { withDefaults } from "../cc-status/settings.js";

// Merged trackers for the dialog: partial legacy settings (e.g. only
// {repositories:[...]}) get full bitbucket/jira defaults, so save-path
// reads never crash on a missing section.
export function trackerDraft(settings) {
  return withDefaults(settings ?? {}).trackers;
}

// The dialog may render before settings load; a null draft must not save.
export function canSave(draft) {
  return Boolean(draft?.trackers);
}

// Save-path writes: trimmed inputs over the merged draft, keeping the
// stored enabled flags and list selections.
export function writeTrackerInputs(trackers, { workspace = "", bbBase = "", jiraBase = "" } = {}) {
  const base = trackerDraft({ trackers });
  return {
    ...base,
    bitbucket: { ...base.bitbucket, workspace: String(workspace).trim(), baseUrl: String(bbBase).trim() },
    jira: { ...base.jira, baseUrl: String(jiraBase).trim() },
  };
}

// Provider tabs: GitHub/Linear/Bitbucket/Jira each get their own tab/view and
// can be enabled independently. Legacy settings files without `trackers`
// default to GitHub + Linear only, preserving the default layout.
//
// A provider tab appears only when enabled AND configured
// (isProviderConfigured true). Enabled-but-unconfigured and disabled both
// hide; setupHint is settings/status guidance only, not a visible tab.
// Status strings are per provider (providerStatus) so a Bitbucket/Jira
// failure never leaks into the GitHub or Linear strings and vice versa.

import { withDefaults } from "./settings.js";
import {
  isTrackerEnabled,
  bitbucketTracker,
  jiraTracker,
  linearTracker,
  sanitizeError,
  JIRA_MCP_SERVER,
  BITBUCKET_MCP_SERVER,
} from "./trackers.js";

export const PROVIDER_IDS = ["github", "bitbucket", "linear", "jira"];
export const REPOSITORY_PROVIDER_IDS = ["github", "bitbucket"];
export const ISSUE_PROVIDER_IDS = ["linear", "jira"];

const LABELS = { github: "GitHub", bitbucket: "Bitbucket", linear: "Linear", jira: "Jira" };
export const providerLabel = (id) => LABELS[id] ?? String(id);

const merged = (settings) => withDefaults(settings ?? {});

// Independent enablement per provider (list membership AND the enabled flag).
export function isProviderEnabled(settings, id) {
  if (!PROVIDER_IDS.includes(id)) return false;
  return isTrackerEnabled(merged(settings), id);
}

// Only enabled AND configured providers get a tab: legacy settings show
// only GitHub + Linear; an enabled-but-unconfigured tracker stays hidden
// (setupHint lives in settings/status guidance, not a visible tab).
export function visibleProviderTabs(settings, getEnv) {
  const s = merged(settings);
  return PROVIDER_IDS.filter((id) => isTrackerEnabled(s, id) && isProviderConfigured(s, id, getEnv));
}

// Views filter shared lists by provider identity (the `source` field), so
// each tab shows only its own tracker's items. An empty source never matches,
// so untagged items stay out of every provider tab.
export function filterBySource(items, source) {
  if (!source) return [];
  return (items ?? []).filter((i) => i?.source === source);
}

// Actions keep the item's origin provider (e.g. cc-start only offers
// move-to-started for Linear issues).
export function actionProvider(item, fallback = null) {
  return item?.source ?? fallback;
}

// Configured = the tracker has what its list view needs. GitHub's gh CLI is
// checked at runtime (a missing gh is ok-empty, not an error); Linear reads
// through the Claude connector headless run; Bitbucket/Jira need their REST
// credentials. No secrets are read here beyond presence checks.
export function isProviderConfigured(settings, id, getEnv) {
  const s = merged(settings);
  if (id === "github") return true;
  if (id === "linear") return linearTracker.isConfigured(s);
  if (id === "bitbucket") return bitbucketTracker.isConfigured(s, getEnv);
  if (id === "jira") return jiraTracker.isConfigured(s, getEnv);
  return false;
}

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

// Per-provider status: disabled / unconfigured / loading / ready / error.
// The text names only this provider and carries only this provider's error
// (sanitized), so provider states never contaminate each other.
export function providerStatus(id, settings, snap = {}, getEnv) {
  const label = providerLabel(id);
  const s = merged(settings);
  if (!PROVIDER_IDS.includes(id) || !isTrackerEnabled(s, id)) return { state: "disabled", text: `${label}: off` };
  if (snap?.notConfigured || !isProviderConfigured(s, id, getEnv)) return { state: "unconfigured", text: `${label}: setup needed` };
  if (snap?.running) return { state: "loading", text: `${label}: checking…` };
  if (snap?.error) return { state: "error", text: `${label}: ${sanitizeError(snap.error).split("\n")[0] || "failed"}` };
  if (snap?.at) return { state: "ready", text: `${label} ${ago(snap.at)}` };
  return { state: "ready", text: label };
}

// Settings/status guidance for an enabled-but-unconfigured provider: where to
// configure it and which credentials/MCP servers it uses. Names env vars
// only, never values. Not a visible tab: unconfigured providers hide.
export function setupHint(id) {
  if (id === "bitbucket") {
    return {
      title: "Connect Bitbucket to see its PRs",
      body: "In settings, turn on Bitbucket and set the workspace slug (the API base stays empty for Bitbucket Cloud). " +
        "Auth uses env ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN — nothing secret is stored here. " +
        `List views also work through the ${BITBUCKET_MCP_SERVER} MCP server (list_pull_requests / get_pull_requests); REST is the fallback.`,
    };
  }
  if (id === "jira") {
    return {
      title: "Connect Jira to see your issues",
      body: "In settings, turn on Jira and set the site URL (like https://yourdomain.atlassian.net, or ATLASSIAN_BASE_URL). " +
        "Auth uses env ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN — nothing secret is stored here. " +
        `List views also work through the ${JIRA_MCP_SERVER} MCP server (jira_search / jira_get_issue). ` +
        "Read only: never transitions or comments.",
    };
  }
  return null;
}

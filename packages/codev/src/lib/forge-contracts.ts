/**
 * TypeScript interfaces for forge concept command JSON output contracts.
 *
 * Default `gh`-based commands produce output conforming to these interfaces.
 * Custom commands for other forges should match these shapes where possible.
 *
 * **Provider presets (gitlab, gitea) are best-effort.** Their CLI tools may
 * output different schemas than GitHub's. Consumers that parse concept output
 * must handle `null` returns gracefully — a non-conforming response from a
 * preset command is treated the same as a command failure.
 *
 * @see codev/specs/589-non-github-repository-support.md
 */

// =============================================================================
// Issue concepts
// =============================================================================

/** Output of the `issue-view` concept command. */
export interface IssueViewResult {
  title: string;
  body: string;
  state: string;
  /**
   * The issue's **browser/web** URL (NOT an API endpoint), when the concept
   * supplies it. Each forge script maps its own web-URL field here: GitHub
   * `url`, GitLab `web_url`, Gitea `html_url` (Gitea's `url` is the API
   * endpoint — do not use it), Linear `url`. Optional to keep the contract
   * forge-neutral (a forge script that doesn't emit it degrades gracefully).
   */
  url?: string;
  comments: Array<{
    body: string;
    createdAt: string;
    author: { login: string };
  }>;
}

/** Single item in `issue-list` concept output. */
export interface IssueListItem {
  number: number | string;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
  createdAt: string;
  closedAt?: string;
  author?: { login: string };
  assignees?: Array<{ login: string }>;
  /**
   * Issue body. Populated by the `issue-search` concept (the backlog-search
   * path); the `issue-list` concept omits it so the always-on `/api/overview`
   * payload stays lean. Non-GitHub forges may not populate it — consumers
   * degrade to title-only matching when it's absent.
   */
  body?: string;
}

/** Output of the `issue-list` concept command. */
export type IssueListResult = IssueListItem[];

/** Output of the `recently-closed` concept command. */
export type RecentlyClosedResult = IssueListItem[];

/** Output of the `issue-comment` concept command: exit code only, no JSON. */
// No interface needed — success is determined by exit code 0.

// =============================================================================
// PR concepts
// =============================================================================

/** Single item in `pr-list` concept output. */
export interface PrListItem {
  number: number;
  title: string;
  url: string;
  reviewDecision: string;
  body: string;
  createdAt: string;
  mergedAt?: string;
  author?: { login: string };
  /**
   * Logins of users requested as reviewers. Emitted by every forge's `pr-list`
   * script (GitHub flattens gh's reviewer objects to logins; GitLab/Gitea emit
   * `[]` as they expose no GitHub-equivalent per-user review-request list).
   * Consumed by the VSCode PR sidebar to bucket "review-requested" PRs.
   */
  reviewRequests: string[];
  /** Whether the PR is a draft. GitLab/Gitea emit `false` (not exposed). */
  isDraft: boolean;
}

/** Output of the `pr-list` concept command. */
export type PrListResult = PrListItem[];

/** Output of the `pr-exists` concept command: JSON boolean on stdout. */
// Returns `true` or `false` as JSON.

/** Single item in `recently-merged` concept output. */
export interface MergedPrItem {
  number: number;
  title: string;
  url?: string;
  body: string;
  createdAt: string;
  mergedAt: string;
  headRefName: string;
}

/** Output of the `recently-merged` concept command. */
export type RecentlyMergedResult = MergedPrItem[];

/** Single item in `pr-search` concept output. */
export interface PrSearchItem {
  number: number;
  headRefName: string;
  /**
   * The PR's base branch. `consult`'s architect path (findPRForIssue) reads it
   * to compute a merge-base against the PR's *actual* base rather than the
   * repo's default branch, and warns and falls back when it is absent — so a
   * concept that can supply it should.
   */
  baseRefName?: string;
  /**
   * `open`, `merged`, or `closed` (closed without merging), when the concept
   * normalises it. Callers read `prs[0]`, and a search spanning every state
   * (which is the default since #1331/#759 — a merged PR must be findable) can
   * otherwise hand them a stale PR with no way to tell. Concepts that emit this
   * order their results open-first.
   */
  state?: 'open' | 'merged' | 'closed';
  title?: string;
  url?: string;
}

/** Output of the `pr-search` concept command. */
export type PrSearchResult = PrSearchItem[];

/** Output of the `pr-view` concept command. */
export interface PrViewResult {
  title: string;
  body: string;
  state: string;
  /**
   * The PR's **browser/web** URL (NOT an API endpoint), when the concept
   * supplies it. Each forge script maps its own web-URL field here: GitHub
   * `url`, GitLab `web_url`, Gitea `html_url` (Gitea's `url` is the API
   * endpoint — do not use it). Optional to keep the contract forge-neutral
   * (a forge script that doesn't emit it degrades gracefully) — same shape
   * as `IssueViewResult.url`.
   */
  url?: string;
  author: { login: string };
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
}

/**
 * Output of the `pr-create` concept command.
 *
 * Inputs are environment variables, like every other concept:
 * `CODEV_PR_TITLE` (required), `CODEV_PR_BODY` (required — set it to `''` for
 * an empty body; an *absent* one is rejected rather than silently posting a
 * bodyless PR), and the optional `CODEV_PR_BASE`, `CODEV_PR_HEAD`,
 * `CODEV_PR_REPO`, `CODEV_PR_DRAFT`. The gitea script also reads the optional
 * `CODEV_PR_LOGIN` (tea's `--login`, for multi-login hosts). A failed creation
 * exits non-zero rather than emitting JSON.
 */
export interface PrCreateResult {
  /** The created PR's number (`iid` on GitLab, `index` on Gitea). */
  number: number;
  /** The created PR's **browser/web** URL — never an API endpoint. */
  url: string;
}

/** Output of the `pr-diff` concept command: raw diff text, not JSON. */
// Returns diff text on stdout. Use `raw: true` option.

/** Output of the `pr-merge` concept command: exit code only, no JSON. */
// No interface needed — success is determined by exit code 0.

// =============================================================================
// Identity & team concepts
// =============================================================================

/** Output of the `user-identity` concept command: plain string (username). */
// Returns username string on stdout. Not JSON.

/** Output of the `team-activity` concept command: raw GraphQL response. */
// Returns the raw GraphQL JSON response. Codev handles parsing via
// parseTeamGraphQLResponse in team-github.ts.

/** Output of the `on-it-timestamps` concept command: raw GraphQL response. */
// Returns the raw GraphQL JSON response. Codev handles parsing to extract
// "On it!" comment timestamps per issue.

// =============================================================================
// Auth concepts
// =============================================================================

/** Output of the `auth-status` concept command: exit code only. */
// Exit code 0 = authenticated, non-zero = not authenticated.

// =============================================================================
// CI concepts (#13)
// =============================================================================
//
// Four concepts, tiered so that the cheap question stays cheap: `ci-runs` and
// `ci-run-view` never read a log, `ci-failures` reads exactly one job's and
// returns a bounded extract, and `ci-run-log` is the deliberate raw window.
//
// Two contract-wide rules, both of which exist because breaking them produced
// real wrong answers:
//
//  1. **Every response that carries log text also carries `logLines`,
//     `returnedLines` and `truncated`.** A trimmed answer must never read as a
//     whole one.
//  2. **Failure is a value, not an absence.** These concepts print `CiError` on
//     stdout even when they exit non-zero, so a timeout, a missing run and a
//     server too old to answer stay distinguishable after
//     `executeForgeCommand` has flattened everything else to `null`. Read them
//     with `executeForgeCommandDetailed` when the distinction matters.

/** Error envelope printed on stdout by any ci-* concept that cannot answer. */
export interface CiError {
  ok: false;
  /**
   * Stable machine token:
   * - `timeout` — the forge did not answer inside the watchdog; carries `seconds`
   * - `not-found` — no such run or job
   * - `unsupported-server` — the forge is too old to have the API; carries
   *   `serverVersion` and `needs`. Distinct from "nothing failed", deliberately:
   *   Forgejo gained the Actions job-log API only in 16.0, and an empty
   *   `failures` array on an older server would say "your CI is fine" when the
   *   truth is "I cannot see your CI at all".
   * - `forge-error` — the forge answered with an error
   * - `bad-input` — missing or unusable input (exit 2)
   */
  error: 'timeout' | 'not-found' | 'unsupported-server' | 'forge-error' | 'bad-input';
  detail: string;
  seconds?: number;
  remedy?: string;
  serverVersion?: string;
  needs?: string;
  runId?: number | string;
  jobId?: number | string;
  jobName?: string;
  /** Failing jobs the concept could still name on an unsupported server. */
  failingJobs?: Array<{ jobId?: number; taskId?: number; jobName: string }>;
}

/** One run in `ci-runs` output. */
export interface CiRunItem {
  /** The API id. This is what ci-run-view / ci-failures / ci-run-log take. */
  id: number;
  /**
   * The human run number (`index_in_repo` on Forgejo, `number` on GitHub).
   * Never pass this as CODEV_CI_RUN_ID: on Forgejo both id spaces resolve on
   * the same route, so a number is silently a *different, real* run.
   */
  number: number;
  name: string;
  workflow: string;
  status: string;
  /** GitHub only. Forgejo has no conclusion field — `status` carries it. */
  conclusion: string | null;
  /**
   * The branch as the forge recorded it. On Forgejo a `pull_request` run
   * records `#<pr-number>` rather than a branch name; ci-runs resolves
   * CODEV_BRANCH_NAME to that form before filtering.
   */
  branch: string | null;
  sha: string | null;
  event: string;
  url: string;
  createdAt: string;
}

/** Output of the `ci-runs` concept. */
export interface CiRunsResult {
  ok: true;
  provider: string;
  runs: CiRunItem[];
  /** True when more runs exist than were returned, for any reason. */
  truncated: boolean;
  note?: string | null;
}

/** One job in `ci-run-view` output. */
export interface CiJobItem {
  /**
   * The job id the log concepts take. **Null on Forgejo < 16**, which exposes
   * no jobs API: those jobs are recovered from `actions/tasks` and only a
   * `taskId` exists. A task id looks like a job id and is not one, so it is
   * never reported as `id`.
   */
  id: number | null;
  taskId?: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** GitHub only; Forgejo exposes no per-step data, so this is `[]` there. */
  failedSteps: Array<{ name: string; number: number; conclusion: string }>;
}

/** Output of the `ci-run-view` concept. */
export interface CiRunViewResult {
  ok: true;
  provider: string;
  /** Which route produced `jobs`: `run-view` | `runs-jobs` | `tasks-scan`. */
  jobSource: string;
  run: Omit<CiRunItem, 'name'> & { title?: string; name?: string };
  jobs: CiJobItem[];
  truncated?: boolean;
}

/** One extracted failure in `ci-failures` output. */
export interface CiFailureItem {
  jobId: number;
  jobName: string;
  stepName?: string | null;
  stepNumber?: number | null;
  /**
   * Which rung of the extraction ladder fired: `vitest`, `go-test`, `tsc`,
   * `runner-marker`, `first-error`. Present so a reader can weigh the answer —
   * a `first-error` match is a weaker claim than a `vitest` one.
   */
  matchedBy?: string;
  text?: string;
  from?: number;
  to?: number;
  logLines: number;
  returnedLines?: number;
  truncated?: boolean;
}

/** Output of the `ci-failures` concept. */
export interface CiFailuresResult {
  ok: true;
  provider: string;
  runId: number | string;
  runStatus: string;
  runConclusion: string | null;
  jobsFailed: number;
  /**
   * False means extraction found nothing it recognised — NOT that the job
   * passed. The response then carries `reason`, the job identity, `logLines`,
   * and a ready-to-run `next` command, so the refusal is a handoff to
   * ci-run-log rather than a dead end. It never falls back to returning
   * arbitrary lines, which a reader would treat as a diagnosis.
   */
  extracted: boolean;
  reason?: string;
  failures: CiFailureItem[];
  otherFailingJobs?: Array<{ id: number; name: string }>;
  cached?: boolean;
  next?: string;
}

/** Output of the `ci-run-log` concept. */
export interface CiRunLogResult {
  ok: true;
  provider: string;
  runId: number | string;
  jobId: number;
  jobName: string;
  window: { kind: 'head' | 'tail' | 'grep'; arg: string };
  logLines: number;
  returnedLines: number;
  /** First and last line numbers returned, into the FULL log. 0/0 for no match. */
  from: number;
  to: number;
  /** False in grep mode: the returned lines have gaps. See `matchLines`. */
  contiguous: boolean;
  truncated: boolean;
  /** grep mode only: how many lines matched, and which. */
  matches: number | null;
  matchLines: number[] | null;
  cached?: boolean;
  lines: string[];
}

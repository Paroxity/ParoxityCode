import type {
  GitRunStackedActionResult,
  GitStackedAction,
  PullRequestChangeBreakdown,
  ReviewDiffPreviewSource,
  VcsStatusResult,
} from "@t3tools/contracts";
import { summarizeChangedFiles } from "@t3tools/shared/changedFileKind";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { resolveVcsUnsupportedReason, type VcsTerminology } from "@t3tools/shared/vcs";
import { msg } from "gt-react";
import { m, type MessageResolver } from "../i18n/messages";
import { changeRequestTermKind } from "./pullRequest/changeRequestTerm";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import {
  changeRequestTerminologyFor,
  type DefaultBranchActionDialogCopy,
  type DefaultBranchConfirmableAction,
  type GitActionHint,
  type GitActionIconName,
  type GitDialogAction,
  resolveGitActionDisabledReason,
  resolveGitMenuItemStates,
  resolveGitQuickActionState,
  vcsActionLabelText,
  WEB_GIT_ACTION_POLICY,
} from "@t3tools/client-runtime/state/vcs";

export {
  requiresDefaultBranchConfirmation,
  type DefaultBranchConfirmableAction,
  type GitActionIconName,
} from "@t3tools/client-runtime/state/vcs";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_publish" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface GitActionProgressPresentation {
  readonly status: string;
  readonly output: string | null;
  readonly startedAtMs: number | null;
}

export interface GitActionResultToastTiming {
  readonly timeout: 0;
  readonly dismissAfterVisibleMs: number | null;
}

export const GIT_ACTION_SUCCESS_VISIBLE_MS = 10_000;

export function resolveGitActionResultToastTiming(
  type: "error" | "success",
): GitActionResultToastTiming {
  return {
    timeout: 0,
    dismissAfterVisibleMs: type === "success" ? GIT_ACTION_SUCCESS_VISIBLE_MS : null,
  };
}

export function resolveGitActionProgressPresentation(
  input: {
    readonly isRunning: boolean;
    readonly operation: string | null;
    readonly currentLabel: string | null;
    readonly hookName?: string | null;
    readonly lastOutputLine: string | null;
    readonly phaseStartedAtMs: number | null;
    readonly hookStartedAtMs: number | null;
  },
  resolve: MessageResolver = m,
): GitActionProgressPresentation | null {
  if (
    !input.isRunning ||
    (input.operation !== "run_change_request" && input.operation !== "pull")
  ) {
    return null;
  }

  const currentLabel = input.currentLabel?.trim();
  const output = input.lastOutputLine?.trim();
  const isPull = input.operation === "pull";
  return {
    status:
      currentLabel && currentLabel !== "Running source control action"
        ? (vcsActionLabelText({ currentLabel, hookName: input.hookName ?? null }, resolve) ??
          currentLabel)
        : isPull
          ? resolve(msg("Pulling latest changes..."))
          : resolve(msg("Starting source control action...")),
    output: !isPull && output ? output : null,
    startedAtMs: isPull
      ? input.phaseStartedAtMs
      : (input.hookStartedAtMs ?? input.phaseStartedAtMs),
  };
}

export function formatGitActionElapsed(
  startedAtMs: number | null,
  nowMs: number,
  resolve: MessageResolver = m,
): string | null {
  if (startedAtMs === null) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) {
    return resolve(msg("{seconds}s", { seconds: elapsedSeconds }));
  }

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return resolve(msg("{minutes}m {seconds}s", { minutes, seconds }));
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
  resolve: MessageResolver = m,
): GitActionMenuItem[] {
  const term = changeRequestTermKind(changeRequestTerminologyFor(gitStatus));
  return resolveGitMenuItemStates(gitStatus, isBusy, hasPrimaryRemote, WEB_GIT_ACTION_POLICY).map(
    (item) => ({
      id: item.id,
      label:
        item.id === "commit"
          ? resolve(msg("Commit", { $context: "verb, git action" }))
          : item.id === "push"
            ? resolve(msg("Push", { $context: "verb, git action" }))
            : resolve(
                msg("Create {term, select, mr {MR} cr {change request} other {PR}}", { term }),
              ),
      disabled: item.disabled,
      icon: item.id,
      kind: "open_dialog",
      ...(item.dialogAction ? { dialogAction: item.dialogAction } : {}),
    }),
  );
}

export function getMenuActionDisabledReason(
  {
    item,
    gitStatus,
    isBusy,
    hasPrimaryRemote,
  }: {
    item: GitActionMenuItem;
    gitStatus: VcsStatusResult | null;
    isBusy: boolean;
    hasPrimaryRemote: boolean;
  },
  resolve: MessageResolver = m,
): string | null {
  const reason = resolveGitActionDisabledReason({
    item,
    gitStatus,
    isBusy,
    hasPrimaryRemote,
    policy: WEB_GIT_ACTION_POLICY,
  });
  if (reason === null) return null;
  const jj = gitStatus?.vcs?.kind === "jj";
  const term = changeRequestTermKind(changeRequestTerminologyFor(gitStatus));
  switch (reason) {
    case "busy":
      return jj
        ? resolve(msg("Jujutsu action in progress."))
        : resolve(msg("Git action in progress."));
    case "status_unavailable":
      return resolve(msg("Git status is unavailable."));
    case "unsupported":
      return resolveVcsUnsupportedReason(gitStatus);
    case "commit_clean":
      return jj
        ? resolve(msg("The working copy is clean. Make changes before committing."))
        : resolve(msg("Worktree is clean. Make changes before committing."));
    case "commit_unavailable":
      return resolve(msg("Commit is currently unavailable."));
    case "push_no_ref":
      return jj
        ? resolve(msg("No bookmark here: create one before pushing."))
        : resolve(msg("Detached HEAD: check out a branch before pushing."));
    case "push_dirty":
    case "pr_dirty":
      return resolve(msg("Commit local changes before pushing."));
    case "push_behind":
      return jj
        ? resolve(msg("Bookmark is behind upstream. Pull/rebase before pushing."))
        : resolve(msg("Branch is behind upstream. Pull/rebase before pushing."));
    case "push_no_origin":
      return resolve(msg('Add an "origin" remote before pushing.'));
    case "push_nothing":
      return jj
        ? resolve(msg("No local changes to push."))
        : resolve(msg("No local commits to push."));
    case "push_unavailable":
      return resolve(msg("Push is currently unavailable."));
    case "pr_no_ref":
      return jj
        ? resolve(
            msg(
              "No bookmark here: create one before creating a {term, select, mr {merge request} cr {change request} other {pull request}}.",
              { term },
            ),
          )
        : resolve(
            msg(
              "Detached HEAD: check out a branch before creating a {term, select, mr {merge request} cr {change request} other {pull request}}.",
              { term },
            ),
          );
    case "pr_no_origin":
      return resolve(
        msg(
          'Add an "origin" remote before creating a {term, select, mr {merge request} cr {change request} other {pull request}}.',
          { term },
        ),
      );
    case "pr_nothing":
      return jj
        ? resolve(
            msg(
              "No local changes to include in a {term, select, mr {merge request} cr {change request} other {pull request}}.",
              { term },
            ),
          )
        : resolve(
            msg(
              "No local commits to include in a {term, select, mr {merge request} cr {change request} other {pull request}}.",
              { term },
            ),
          );
    case "pr_behind":
      return jj
        ? resolve(
            msg(
              "Bookmark is behind upstream. Pull/rebase before creating a {term, select, mr {merge request} cr {change request} other {pull request}}.",
              { term },
            ),
          )
        : resolve(
            msg(
              "Branch is behind upstream. Pull/rebase before creating a {term, select, mr {merge request} cr {change request} other {pull request}}.",
              { term },
            ),
          );
    // Web lists no pull request item once one is open, so only the create copy applies.
    case "view_pr_unavailable":
    case "pr_unavailable":
      return resolve(
        msg(
          "Create {term, select, mr {merge request} cr {change request} other {pull request}} is currently unavailable.",
          { term },
        ),
      );
  }
}

export function hasUsableGitMenuContent(input: {
  readonly menuItems: readonly GitActionMenuItem[];
  readonly canWriteSourceControl: boolean;
  readonly canPublishRepository: boolean;
  readonly hasNotice: boolean;
}): boolean {
  return (
    input.canPublishRepository ||
    input.hasNotice ||
    (input.canWriteSourceControl && input.menuItems.some((item) => !item.disabled))
  );
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultRef = false,
  hasPrimaryRemote = true,
  resolve: MessageResolver = m,
): GitQuickAction {
  const state = resolveGitQuickActionState(
    gitStatus,
    isBusy,
    isDefaultRef,
    hasPrimaryRemote,
    WEB_GIT_ACTION_POLICY,
  );
  const jj = gitStatus?.vcs?.kind === "jj";
  const term = changeRequestTermKind(changeRequestTerminologyFor(gitStatus));
  switch (state.kind) {
    case "run_pull":
      return { label: resolve(msg("Pull")), disabled: false, kind: "run_pull" };
    case "open_publish":
      return { label: resolve(msg("Publish repository")), disabled: false, kind: "open_publish" };
    // Web's policy never views an open pull request here; the header links it.
    case "open_pr":
      return {
        label: resolve(msg("Commit", { $context: "verb, git action" })),
        disabled: true,
        kind: "show_hint",
        hint: webQuickActionHint("up_to_date", gitStatus, term, resolve),
      };
    case "run_action": {
      const labels = {
        commit: () => resolve(msg("Commit", { $context: "verb, git action" })),
        commit_push: () => resolve(msg("Commit & push")),
        commit_push_pr: () =>
          resolve(
            msg("Commit, push & {term, select, mr {MR} cr {change request} other {PR}}", { term }),
          ),
        push: () => resolve(msg("Push", { $context: "verb, git action" })),
        push_rewrite: () =>
          resolve(msg("Push rewrite", { $context: "verb, replaces the pushed versions" })),
        push_create_pr: () =>
          resolve(
            msg("Push & create {term, select, mr {MR} cr {change request} other {PR}}", { term }),
          ),
        create_pr: () =>
          resolve(msg("Create {term, select, mr {MR} cr {change request} other {PR}}", { term })),
      };
      return {
        label: labels[state.label](),
        disabled: false,
        kind: "run_action",
        action: state.action,
      };
    }
    case "show_hint":
      return {
        label:
          state.label === "push"
            ? resolve(msg("Push", { $context: "verb, git action" }))
            : state.label === "sync"
              ? jj
                ? resolve(msg("Sync bookmark"))
                : resolve(msg("Sync ref"))
              : resolve(msg("Commit", { $context: "verb, git action" })),
        disabled: true,
        kind: "show_hint",
        hint: webQuickActionHint(state.hint, gitStatus, term, resolve),
      };
  }
}

function webQuickActionHint(
  hint: GitActionHint,
  gitStatus: VcsStatusResult | null,
  term: ReturnType<typeof changeRequestTermKind>,
  resolve: MessageResolver,
): string {
  const jj = gitStatus?.vcs?.kind === "jj";
  switch (hint) {
    case "busy":
      return jj
        ? resolve(msg("Jujutsu action in progress."))
        : resolve(msg("Git action in progress."));
    case "status_unavailable":
      return resolve(msg("Git status is unavailable."));
    case "unsupported":
      return resolveVcsUnsupportedReason(gitStatus) ?? "";
    case "no_ref":
      return jj
        ? resolve(
            msg(
              "No bookmark here: create one before pushing or opening a {term, select, mr {merge request} cr {change request} other {pull request}}.",
              { term },
            ),
          )
        : resolve(
            msg(
              "Create and checkout a ref before pushing or opening a {term, select, mr {merge request} cr {change request} other {pull request}}.",
              { term },
            ),
          );
    // Web publishes the repository instead of hinting at a missing remote.
    case "no_origin":
      return resolve(msg('Add an "origin" remote before pushing.'));
    case "nothing_to_push":
      return jj
        ? resolve(msg("No local changes to push."))
        : resolve(msg("No local commits to push."));
    case "diverged":
      return jj
        ? resolve(msg("Bookmark has diverged from upstream. Rebase/merge first."))
        : resolve(msg("Branch has diverged from upstream. Rebase/merge first."));
    case "up_to_date":
      return jj
        ? resolve(msg("Bookmark is up to date. No action needed."))
        : resolve(msg("Branch is up to date. No action needed."));
  }
}

export function resolveDefaultBranchActionDialogCopy(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
    terminology: ChangeRequestTerminology;
    vcsTerminology?: VcsTerminology;
  },
  resolve: MessageResolver = m,
): DefaultBranchActionDialogCopy {
  const branch = input.branchName;
  const term = changeRequestTermKind(input.terminology);

  if (input.vcsTerminology?.kind === "jj") {
    if (input.action === "push" || input.action === "commit_push") {
      return input.includesCommit
        ? {
            title: resolve(msg("Commit & push to default bookmark?")),
            description: resolve(
              msg(
                'This action will commit and push changes on "{branch}". You can continue on this bookmark or create a feature bookmark and run the same action there.',
                { branch },
              ),
            ),
            continueLabel: resolve(msg("Commit & push to {branch}", { branch })),
          }
        : {
            title: resolve(msg("Push to default bookmark?")),
            description: resolve(
              msg(
                'This action will push local changes on "{branch}". You can continue on this bookmark or create a feature bookmark and run the same action there.',
                { branch },
              ),
            ),
            continueLabel: resolve(msg("Push to {branch}", { branch })),
          };
    }
    return input.includesCommit
      ? {
          title: resolve(
            msg(
              "Commit, push & create {term, select, mr {MR} cr {change request} other {PR}} from default bookmark?",
              { term },
            ),
          ),
          description: resolve(
            msg(
              'This action will commit, push, and create a {term, select, mr {merge request} cr {change request} other {pull request}} on "{branch}". You can continue on this bookmark or create a feature bookmark and run the same action there.',
              { term, branch },
            ),
          ),
          continueLabel: resolve(
            msg("Commit, push & create {term, select, mr {MR} cr {change request} other {PR}}", {
              term,
            }),
          ),
        }
      : {
          title: resolve(
            msg(
              "Push & create {term, select, mr {MR} cr {change request} other {PR}} from default bookmark?",
              { term },
            ),
          ),
          description: resolve(
            msg(
              'This action will push local changes and create a {term, select, mr {merge request} cr {change request} other {pull request}} on "{branch}". You can continue on this bookmark or create a feature bookmark and run the same action there.',
              { term, branch },
            ),
          ),
          continueLabel: resolve(
            msg("Push & create {term, select, mr {MR} cr {change request} other {PR}}", { term }),
          ),
        };
  }

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: resolve(msg("Commit & push to default ref?")),
        description: resolve(
          msg(
            'This action will commit and push changes on "{branch}". You can continue on this ref or create a feature ref and run the same action there.',
            { branch },
          ),
        ),
        continueLabel: resolve(msg("Commit & push to {branch}", { branch })),
      };
    }
    return {
      title: resolve(msg("Push to default ref?")),
      description: resolve(
        msg(
          'This action will push local commits on "{branch}". You can continue on this ref or create a feature ref and run the same action there.',
          { branch },
        ),
      ),
      continueLabel: resolve(msg("Push to {branch}", { branch })),
    };
  }

  if (input.includesCommit) {
    return {
      title: resolve(
        msg(
          "Commit, push & create {term, select, mr {MR} cr {change request} other {PR}} from default ref?",
          { term },
        ),
      ),
      description: resolve(
        msg(
          'This action will commit, push, and create a {term, select, mr {merge request} cr {change request} other {pull request}} on "{branch}". You can continue on this ref or create a feature ref and run the same action there.',
          { term, branch },
        ),
      ),
      continueLabel: resolve(
        msg("Commit, push & create {term, select, mr {MR} cr {change request} other {PR}}", {
          term,
        }),
      ),
    };
  }
  return {
    title: resolve(
      msg(
        "Push & create {term, select, mr {MR} cr {change request} other {PR}} from default ref?",
        { term },
      ),
    ),
    description: resolve(
      msg(
        'This action will push local commits and create a {term, select, mr {merge request} cr {change request} other {pull request}} on "{branch}". You can continue on this ref or create a feature ref and run the same action there.',
        { term, branch },
      ),
    ),
    continueLabel: resolve(
      msg("Push & create {term, select, mr {MR} cr {change request} other {PR}}", { term }),
    ),
  };
}

/** The server names a feature branch from the commit it makes, so the action must commit changes. */
export function resolveFeatureBranchUnavailableReason(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    hasWorkingTreeChanges: boolean;
    vcsTerminology?: VcsTerminology;
  },
  resolve: MessageResolver = m,
): string | null {
  const jj = input.vcsTerminology?.kind === "jj";
  if (!input.hasWorkingTreeChanges) {
    if (jj) {
      return resolve(
        msg(
          "There are no changes to commit, so a feature bookmark can't be named. Create a bookmark yourself or continue on {branch}.",
          { branch: input.branchName },
        ),
      );
    }
    return resolve(
      msg(
        "There are no changes to commit, so a feature branch can't be named. Create a branch yourself or continue on {branch}.",
        { branch: input.branchName },
      ),
    );
  }
  if (input.action === "push" || input.action === "create_pr") {
    if (jj) {
      return resolve(
        msg(
          "This action doesn't commit your changes, so a feature bookmark can't be named. Create a bookmark yourself or continue on {branch}.",
          { branch: input.branchName },
        ),
      );
    }
    return resolve(
      msg(
        "This action doesn't commit your changes, so a feature branch can't be named. Create a branch yourself or continue on {branch}.",
        { branch: input.branchName },
      ),
    );
  }
  return null;
}

export function resolveThreadBranchUpdate(
  result: GitRunStackedActionResult,
): { branch: string } | null {
  if (result.branch.status !== "created" || !result.branch.name) {
    return null;
  }

  return {
    branch: result.branch.name,
  };
}

export function resolveThreadBranchMetadataPatch(
  branch: string | null,
  expectedBranch: string | null,
): {
  branch: string | null;
  expectedBranch: string | null;
} {
  return { branch, expectedBranch };
}

export function resolveLiveThreadBranchUpdate(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
}): { branch: string | null } | null {
  if (!input.gitStatus) {
    return null;
  }

  if (input.gitStatus.refName === null && input.threadBranch !== null) {
    return null;
  }

  if (input.threadBranch === input.gitStatus.refName) {
    return null;
  }

  if (
    input.threadBranch !== null &&
    input.gitStatus.refName !== null &&
    !isTemporaryWorktreeBranch(input.threadBranch) &&
    isTemporaryWorktreeBranch(input.gitStatus.refName)
  ) {
    return null;
  }

  return {
    branch: input.gitStatus.refName,
  };
}

export type ChangesLineTotals = {
  readonly insertions: number;
  readonly deletions: number;
  /** Ref the counts compare against; `null` means they are uncommitted changes against HEAD. */
  readonly baseRef: string | null;
  /** `null` when the selected totals carry no per-file stats. */
  readonly breakdown: PullRequestChangeBreakdown;
};

// `branchChanges ?? workingTree` treats `{0,0}` as present, so a zero branch total hid a dirty
// working tree and the Changes row read +0 while Diff still showed the work.
// The Diff panel's branch comparison wins when it has file stats, so a remembered base or
// hidden whitespace reads the same in the row as in the panel.
export function resolveChangesTotals(
  status: VcsStatusResult | null | undefined,
  branchPreview?: ReviewDiffPreviewSource | null,
): ChangesLineTotals | null {
  if (branchPreview?.files) {
    let insertions = 0;
    let deletions = 0;
    for (const file of branchPreview.files) {
      insertions += file.additions;
      deletions += file.deletions;
    }
    return {
      insertions,
      deletions,
      baseRef: branchPreview.baseRef,
      breakdown: summarizeChangedFiles(branchPreview.files),
    };
  }
  if (!status) return null;
  const branch = status.branchChanges;
  const tree = { ...status.workingTree, baseRef: null };
  const selected =
    branch && (branch.insertions > 0 || branch.deletions > 0)
      ? branch
      : tree.insertions > 0 || tree.deletions > 0
        ? tree
        : (branch ?? tree);
  return {
    insertions: selected.insertions,
    deletions: selected.deletions,
    baseRef: selected.baseRef,
    breakdown:
      selected === tree
        ? summarizeChangedFiles(
            tree.files.map((file) => ({
              path: file.path,
              additions: file.insertions,
              deletions: file.deletions,
            })),
          )
        : null,
  };
}

import type {
  GitRunStackedActionInput,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { resolveVcsUnsupportedReason, type VcsTerminology } from "@t3tools/shared/vcs";
import { type ChangeRequestTerminology, sourceControlClients } from "../sourceControlClients.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export type GitActionIconName = "commit" | "push" | "pr";

export type GitDialogAction = "commit" | "push" | "create_pr";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_pr" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

export type GitActionRequestInput = Pick<
  GitRunStackedActionInput,
  "action" | "commitMessage" | "featureBranch" | "filePaths"
>;

export function changeRequestTerminologyFor(
  gitStatus: VcsStatusResult | null,
): ChangeRequestTerminology {
  return sourceControlClients.get(gitStatus?.sourceControlProvider?.kind).changeRequest;
}

/**
 * Where web and mobile deliberately differ. The decisions below are shared; each surface renders
 * its own translated copy from them.
 */
export interface GitActionPolicy {
  /** Without a primary remote, offer "Publish repository" instead of Push and pull request actions. */
  readonly publishWithoutRemote: boolean;
  /** Offer "View PR" for an open pull request; web shows it in the header instead. */
  readonly viewOpenPr: boolean;
  /** Allow Push while the working tree has changes; only committed work is pushed. */
  readonly pushWithChanges: boolean;
}

const MOBILE_GIT_ACTION_POLICY: GitActionPolicy = {
  publishWithoutRemote: false,
  viewOpenPr: true,
  pushWithChanges: false,
};

export const WEB_GIT_ACTION_POLICY: GitActionPolicy = {
  publishWithoutRemote: true,
  viewOpenPr: false,
  pushWithChanges: true,
};

export interface GitMenuItemState {
  readonly id: GitActionMenuItem["id"];
  readonly disabled: boolean;
  /** `open_pr` is the "View PR" item; the rest open a dialog for `dialogAction`. */
  readonly kind: GitActionMenuItem["kind"];
  readonly dialogAction?: GitDialogAction;
}

export type GitActionHint =
  | "busy"
  | "status_unavailable"
  | "unsupported"
  | "no_ref"
  | "no_origin"
  | "nothing_to_push"
  | "diverged"
  | "up_to_date";

export type GitQuickActionState =
  | {
      readonly kind: "run_action";
      readonly action: GitStackedAction;
      /** `push_create_pr` and `create_pr` both run `create_pr`; only the first pushes first. */
      readonly label:
        | "commit"
        | "commit_push"
        | "commit_push_pr"
        | "push"
        | "push_rewrite"
        | "push_create_pr"
        | "create_pr";
    }
  | { readonly kind: "run_pull" }
  | { readonly kind: "open_pr" }
  | { readonly kind: "open_publish" }
  | {
      readonly kind: "show_hint";
      readonly label: "commit" | "push" | "sync";
      readonly hint: GitActionHint;
    };

export type GitActionDisabledReason =
  | "busy"
  | "status_unavailable"
  | "unsupported"
  | "commit_clean"
  | "commit_unavailable"
  | "push_no_ref"
  | "push_dirty"
  | "push_behind"
  | "push_no_origin"
  | "push_nothing"
  | "push_unavailable"
  | "view_pr_unavailable"
  | "pr_no_ref"
  | "pr_dirty"
  | "pr_no_origin"
  | "pr_nothing"
  | "pr_behind"
  | "pr_unavailable";

function hasDefaultRefDelta(gitStatus: VcsStatusResult): boolean {
  return (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
}

export function resolveGitMenuItemStates(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote: boolean,
  policy: GitActionPolicy,
): GitMenuItemState[] {
  if (!gitStatus) return [];
  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const canReachRemote = gitStatus.hasUpstream || hasPrimaryRemote;
  const blocked = isBusy || resolveVcsUnsupportedReason(gitStatus) !== null;
  const canPush =
    !blocked &&
    hasBranch &&
    (policy.pushWithChanges || !hasChanges) &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    canReachRemote;
  const canCreatePr =
    !blocked &&
    hasBranch &&
    !hasOpenPr &&
    // jj pushes the bookmark's change, so working-copy edits would be left out of the request.
    !(gitStatus.vcs?.kind === "jj" && hasChanges) &&
    hasDefaultRefDelta(gitStatus) &&
    !isBehind &&
    canReachRemote;

  const commit: GitMenuItemState = {
    id: "commit",
    disabled: blocked || !hasChanges,
    kind: "open_dialog",
    dialogAction: "commit",
  };
  if (policy.publishWithoutRemote && !hasPrimaryRemote) return [commit];
  const push: GitMenuItemState = {
    id: "push",
    disabled: !canPush,
    kind: "open_dialog",
    dialogAction: "push",
  };
  if (hasOpenPr) {
    return policy.viewOpenPr
      ? [commit, push, { id: "pr", disabled: blocked, kind: "open_pr" }]
      : [commit, push];
  }
  return [
    commit,
    push,
    { id: "pr", disabled: !canCreatePr, kind: "open_dialog", dialogAction: "create_pr" },
  ];
}

export function resolveGitQuickActionState(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultRef: boolean,
  hasPrimaryRemote: boolean,
  policy: GitActionPolicy,
): GitQuickActionState {
  if (isBusy) return { kind: "show_hint", label: "commit", hint: "busy" };
  if (!gitStatus) return { kind: "show_hint", label: "commit", hint: "status_unavailable" };
  if (resolveVcsUnsupportedReason(gitStatus) !== null) {
    return { kind: "show_hint", label: "commit", hint: "unsupported" };
  }

  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const upToDate = { kind: "show_hint", label: "commit", hint: "up_to_date" } as const;
  const openPrOrUpToDate = policy.viewOpenPr ? ({ kind: "open_pr" } as const) : upToDate;

  if (gitStatus.refName === null) return { kind: "show_hint", label: "commit", hint: "no_ref" };

  if (gitStatus.hasWorkingTreeChanges) {
    if (isBehind || (!gitStatus.hasUpstream && !hasPrimaryRemote)) {
      return { kind: "run_action", action: "commit", label: "commit" };
    }
    return hasOpenPr || isDefaultRef
      ? { kind: "run_action", action: "commit_push", label: "commit_push" }
      : { kind: "run_action", action: "commit_push_pr", label: "commit_push_pr" };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      if (policy.publishWithoutRemote) return { kind: "open_publish" };
      if (hasOpenPr && !isAhead) return openPrOrUpToDate;
      return { kind: "show_hint", label: "push", hint: "no_origin" };
    }
    if (!isAhead) {
      return hasOpenPr
        ? openPrOrUpToDate
        : { kind: "show_hint", label: "push", hint: "nothing_to_push" };
    }
    return hasOpenPr || isDefaultRef
      ? { kind: "run_action", action: "push", label: "push" }
      : { kind: "run_action", action: "create_pr", label: "push_create_pr" };
  }

  if (isAhead && isBehind) return { kind: "show_hint", label: "sync", hint: "diverged" };
  if (isBehind) return { kind: "run_pull" };
  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        kind: "run_action",
        action: "push",
        label: gitStatus.rewritesUpstream ? "push_rewrite" : "push",
      };
    }
    return { kind: "run_action", action: "create_pr", label: "push_create_pr" };
  }
  if (hasOpenPr) return openPrOrUpToDate;
  if (hasDefaultRefDelta(gitStatus) && !isDefaultRef) {
    return { kind: "run_action", action: "create_pr", label: "create_pr" };
  }
  return upToDate;
}

export function resolveGitActionDisabledReason(input: {
  readonly item: Pick<GitMenuItemState, "id" | "disabled">;
  readonly gitStatus: VcsStatusResult | null;
  readonly isBusy: boolean;
  readonly hasPrimaryRemote: boolean;
  readonly policy: GitActionPolicy;
}): GitActionDisabledReason | null {
  const { item, gitStatus, isBusy, hasPrimaryRemote, policy } = input;
  if (!item.disabled) return null;
  if (isBusy) return "busy";
  if (!gitStatus) return "status_unavailable";
  if (resolveVcsUnsupportedReason(gitStatus) !== null) return "unsupported";

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const isBehind = gitStatus.behindCount > 0;
  const hasRemote = gitStatus.hasUpstream || hasPrimaryRemote;

  if (item.id === "commit") return hasChanges ? "commit_unavailable" : "commit_clean";

  if (item.id === "push") {
    if (!hasBranch) return "push_no_ref";
    if (hasChanges && !policy.pushWithChanges) return "push_dirty";
    if (isBehind) return "push_behind";
    if (!hasRemote) return "push_no_origin";
    if (gitStatus.aheadCount <= 0) return "push_nothing";
    return "push_unavailable";
  }

  if (gitStatus.pr?.state === "open") return "view_pr_unavailable";
  if (!hasBranch) return "pr_no_ref";
  if (gitStatus.vcs?.kind === "jj" && hasChanges) return "pr_dirty";
  if (!hasRemote) return "pr_no_origin";
  if (!hasDefaultRefDelta(gitStatus)) return "pr_nothing";
  if (isBehind) return "pr_behind";
  return "pr_unavailable";
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasOriginRemote = true,
  resolve: MFunctionType = mFallback,
): GitActionMenuItem[] {
  const terminology = changeRequestTerminologyFor(gitStatus);
  return resolveGitMenuItemStates(gitStatus, isBusy, hasOriginRemote, MOBILE_GIT_ACTION_POLICY).map(
    (item) => ({
      ...item,
      icon: item.id,
      label:
        item.id === "commit"
          ? resolve(msg("Commit", { $context: "verb, git action" }))
          : item.id === "push"
            ? resolve(msg("Push", { $context: "verb, git action" }))
            : item.kind === "open_pr"
              ? resolve(msg("View {shortLabel}", { shortLabel: terminology.shortLabel }))
              : resolve(msg("Create {shortLabel}", { shortLabel: terminology.shortLabel })),
    }),
  );
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultBranch = false,
  hasOriginRemote = true,
  resolve: MFunctionType = mFallback,
): GitQuickAction {
  const state = resolveGitQuickActionState(
    gitStatus,
    isBusy,
    isDefaultBranch,
    hasOriginRemote,
    MOBILE_GIT_ACTION_POLICY,
  );
  const jj = gitStatus?.vcs?.kind === "jj";
  const terminology = changeRequestTerminologyFor(gitStatus);
  const { shortLabel } = terminology;
  switch (state.kind) {
    case "run_pull":
      return {
        label: resolve(msg("Pull", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_pull",
      };
    case "open_pr":
      return {
        label: resolve(msg("View {shortLabel}", { shortLabel })),
        disabled: false,
        kind: "open_pr",
      };
    case "open_publish":
      // Mobile's policy never publishes; keep the type exhaustive.
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: true,
        kind: "show_hint",
      };
    case "run_action": {
      const labels = {
        commit: () => resolve(msg("Commit", { $context: "verb, git action" })),
        commit_push: () => resolve(msg("Commit & push")),
        commit_push_pr: () => resolve(msg("Commit, push & {shortLabel}", { shortLabel })),
        push: () => resolve(msg("Push", { $context: "verb, git action" })),
        push_rewrite: () =>
          resolve(msg("Push rewrite", { $context: "verb, replaces the pushed versions" })),
        push_create_pr: () => resolve(msg("Push & create {shortLabel}", { shortLabel })),
        create_pr: () => resolve(msg("Create {shortLabel}", { shortLabel })),
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
                : resolve(msg("Sync branch"))
              : resolve(msg("Commit", { $context: "verb, git action" })),
        disabled: true,
        kind: "show_hint",
        hint: mobileQuickActionHint(state.hint, gitStatus, terminology, resolve),
      };
  }
}

function mobileQuickActionHint(
  hint: GitActionHint,
  gitStatus: VcsStatusResult | null,
  terminology: ChangeRequestTerminology,
  resolve: MFunctionType,
): string {
  const jj = gitStatus?.vcs?.kind === "jj";
  const kind = changeRequestKind(terminology);
  const changeRequest = terminology.shortLabelWithArticle;
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
            msg("No bookmark here: create one before pushing or opening {changeRequest}.", {
              changeRequest,
            }),
          )
        : resolve(
            msg(
              "{kind, select, pr {Create and checkout a branch before pushing or opening a PR.} mr {Create and checkout a branch before pushing or opening an MR.} generic {Create and checkout a branch before pushing or opening a change request.} other {Create and checkout a branch before pushing or opening {changeRequest}.}}",
              { kind, changeRequest },
            ),
          );
    case "no_origin":
      return resolve(
        msg(
          '{kind, select, pr {Add an "origin" remote before pushing or creating a PR.} mr {Add an "origin" remote before pushing or creating an MR.} generic {Add an "origin" remote before pushing or creating a change request.} other {Add an "origin" remote before pushing or creating {changeRequest}.}}',
          { kind, changeRequest },
        ),
      );
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

export function getGitActionDisabledReason(
  input: {
    item: GitActionMenuItem;
    gitStatus: VcsStatusResult | null;
    isBusy: boolean;
    hasOriginRemote: boolean;
  },
  resolve: MFunctionType = mFallback,
): string | null {
  const { gitStatus } = input;
  const reason = resolveGitActionDisabledReason({
    item: input.item,
    gitStatus,
    isBusy: input.isBusy,
    hasPrimaryRemote: input.hasOriginRemote,
    policy: MOBILE_GIT_ACTION_POLICY,
  });
  if (reason === null) return null;
  const jj = gitStatus?.vcs?.kind === "jj";
  const terminology = changeRequestTerminologyFor(gitStatus);
  const { shortLabel } = terminology;
  const changeRequest = terminology.shortLabelWithArticle;
  const kind = changeRequestKind(terminology);
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
        ? resolve(msg("Workspace is clean. Make changes before committing."))
        : resolve(msg("Worktree is clean. Make changes before committing."));
    case "commit_unavailable":
      return resolve(msg("Commit is currently unavailable."));
    case "push_no_ref":
      return jj
        ? resolve(msg("No bookmark here: create one before pushing."))
        : resolve(msg("Detached HEAD: checkout a branch before pushing."));
    case "push_dirty":
      return jj
        ? resolve(msg("Commit local changes before pushing."))
        : resolve(msg("Commit or stash local changes before pushing."));
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
    case "view_pr_unavailable":
      return resolve(msg("View {shortLabel} is currently unavailable.", { shortLabel }));
    case "pr_no_ref":
      return jj
        ? resolve(
            msg("No bookmark here: create one before creating {changeRequest}.", { changeRequest }),
          )
        : resolve(
            msg(
              "{kind, select, pr {Detached HEAD: checkout a branch before creating a PR.} mr {Detached HEAD: checkout a branch before creating an MR.} generic {Detached HEAD: checkout a branch before creating a change request.} other {Detached HEAD: checkout a branch before creating {changeRequest}.}}",
              { kind, changeRequest },
            ),
          );
    case "pr_dirty":
      return resolve(msg("Commit local changes before pushing."));
    case "pr_no_origin":
      return resolve(
        msg(
          '{kind, select, pr {Add an "origin" remote before creating a PR.} mr {Add an "origin" remote before creating an MR.} generic {Add an "origin" remote before creating a change request.} other {Add an "origin" remote before creating {changeRequest}.}}',
          { kind, changeRequest },
        ),
      );
    case "pr_nothing":
      return jj
        ? resolve(msg("No local changes to include in {changeRequest}.", { changeRequest }))
        : resolve(
            msg(
              "{kind, select, pr {No local commits to include in a PR.} mr {No local commits to include in an MR.} generic {No local commits to include in a change request.} other {No local commits to include in {changeRequest}.}}",
              { kind, changeRequest },
            ),
          );
    case "pr_behind":
      return jj
        ? resolve(
            msg("Bookmark is behind upstream. Pull/rebase before creating {changeRequest}.", {
              changeRequest,
            }),
          )
        : resolve(
            msg(
              "{kind, select, pr {Branch is behind upstream. Pull/rebase before creating a PR.} mr {Branch is behind upstream. Pull/rebase before creating an MR.} generic {Branch is behind upstream. Pull/rebase before creating a change request.} other {Branch is behind upstream. Pull/rebase before creating {changeRequest}.}}",
              { kind, changeRequest },
            ),
          );
    case "pr_unavailable":
      return resolve(msg("Create {shortLabel} is currently unavailable.", { shortLabel }));
  }
}

/** Picks the whole sentence for the provider's term; English keeps `shortLabelWithArticle`. */
function changeRequestKind(
  terminology: ChangeRequestTerminology,
): "pr" | "mr" | "generic" | "other" {
  switch (terminology.shortLabelWithArticle) {
    case "a PR":
      return "pr";
    case "an MR":
      return "mr";
    case "a change request":
      return "generic";
    default:
      return "other";
  }
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultBranch: boolean,
): boolean {
  if (!isDefaultBranch) return false;
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export function resolveDefaultBranchActionDialogCopy(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
    terminology: ChangeRequestTerminology;
    vcsTerminology?: VcsTerminology;
  },
  resolve: MFunctionType = mFallback,
): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const { shortLabel, shortLabelWithArticle } = input.terminology;

  if (input.vcsTerminology?.kind === "jj") {
    const values = { branch: branchLabel, changeRequest: shortLabelWithArticle };
    if (input.action === "push" || input.action === "commit_push") {
      return input.includesCommit
        ? {
            title: resolve(msg("Commit & push to default bookmark?")),
            description: resolve(
              msg(
                'This action will commit and push changes on "{branch}". You can continue on this bookmark or create a feature bookmark and run the same action there.',
                { branch: branchLabel },
              ),
            ),
            continueLabel: resolve(msg("Commit & push to {branch}", { branch: branchLabel })),
          }
        : {
            title: resolve(msg("Push to default bookmark?")),
            description: resolve(
              msg(
                'This action will push local changes on "{branch}". You can continue on this bookmark or create a feature bookmark and run the same action there.',
                { branch: branchLabel },
              ),
            ),
            continueLabel: resolve(msg("Push to {branch}", { branch: branchLabel })),
          };
    }
    return input.includesCommit
      ? {
          title: resolve(
            msg("Commit, push & create {shortLabel} from default bookmark?", { shortLabel }),
          ),
          description: resolve(
            msg(
              'This action will commit, push, and create {changeRequest} on "{branch}". You can continue on this bookmark or create a feature bookmark and run the same action there.',
              values,
            ),
          ),
          continueLabel: resolve(msg("Commit, push & create {shortLabel}", { shortLabel })),
        }
      : {
          title: resolve(msg("Push & create {shortLabel} from default bookmark?", { shortLabel })),
          description: resolve(
            msg(
              'This action will push local changes and create {changeRequest} on "{branch}". You can continue on this bookmark or create a feature bookmark and run the same action there.',
              values,
            ),
          ),
          continueLabel: resolve(msg("Push & create {shortLabel}", { shortLabel })),
        };
  }

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: resolve(msg("Commit & push to default branch?")),
        description: resolve(
          msg(
            'This action will commit and push changes on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
            { branch: branchLabel },
          ),
        ),
        continueLabel: resolve(msg("Commit & push to {branch}", { branch: branchLabel })),
      };
    }
    return {
      title: resolve(msg("Push to default branch?")),
      description: resolve(
        msg(
          'This action will push local commits on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
          { branch: branchLabel },
        ),
      ),
      continueLabel: resolve(msg("Push to {branch}", { branch: branchLabel })),
    };
  }

  if (input.includesCommit) {
    return {
      title: resolve(
        msg("Commit, push & create {shortLabel} from default branch?", { shortLabel }),
      ),
      description: resolve(
        msg(
          '{kind, select, pr {This action will commit, push, and create a PR on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} mr {This action will commit, push, and create an MR on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} generic {This action will commit, push, and create a change request on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} other {This action will commit, push, and create {changeRequest} on "{branch}". You can continue on this branch or create a feature branch and run the same action there.}}',
          {
            kind: changeRequestKind(input.terminology),
            changeRequest: shortLabelWithArticle,
            branch: branchLabel,
          },
        ),
      ),
      continueLabel: resolve(msg("Commit, push & create {shortLabel}", { shortLabel })),
    };
  }
  return {
    title: resolve(msg("Push & create {shortLabel} from default branch?", { shortLabel })),
    description: resolve(
      msg(
        '{kind, select, pr {This action will push local commits and create a PR on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} mr {This action will push local commits and create an MR on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} generic {This action will push local commits and create a change request on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} other {This action will push local commits and create {changeRequest} on "{branch}". You can continue on this branch or create a feature branch and run the same action there.}}',
        {
          kind: changeRequestKind(input.terminology),
          changeRequest: shortLabelWithArticle,
          branch: branchLabel,
        },
      ),
    ),
    continueLabel: resolve(msg("Push & create {shortLabel}", { shortLabel })),
  };
}

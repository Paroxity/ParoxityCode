import type { VcsDriverKind, VcsStatusLocalResult } from "@t3tools/contracts";

/**
 * Clients branch on `kind` to pick whole translated sentences. The nouns are English-only and
 * exist for server text such as MCP tool descriptions and errors.
 */
export interface VcsTerminology {
  readonly kind: "git" | "jj";
  readonly systemName: string;
  readonly repositoryAdjective: string;
  readonly workspaceNoun: string;
  readonly workspaceNounPlural: string;
}

export const GIT_VCS_TERMINOLOGY: VcsTerminology = {
  kind: "git",
  systemName: "Git",
  repositoryAdjective: "git",
  workspaceNoun: "worktree",
  workspaceNounPlural: "worktrees",
};

export const JJ_VCS_TERMINOLOGY: VcsTerminology = {
  kind: "jj",
  systemName: "Jujutsu",
  repositoryAdjective: "Jujutsu",
  workspaceNoun: "workspace",
  workspaceNounPlural: "workspaces",
};

/** `null`/`undefined`/`"unknown"` resolve to Git terms so a transient status never flips copy. */
export function getVcsTerminology(kind: VcsDriverKind | null | undefined): VcsTerminology {
  return kind === "jj" ? JJ_VCS_TERMINOLOGY : GIT_VCS_TERMINOLOGY;
}

/** The accessor every client surface uses; mirrors `resolveChangeRequestTerminology`. */
export function resolveVcsTerminology(
  status: Pick<VcsStatusLocalResult, "vcs"> | null | undefined,
): VcsTerminology {
  return getVcsTerminology(status?.vcs?.kind);
}

/** Present only when the workspace's VCS is detected but unusable. */
export function resolveVcsUnsupportedReason(
  status: Pick<VcsStatusLocalResult, "vcs"> | null | undefined,
): string | null {
  const vcs = status?.vcs;
  return vcs && "unsupportedReason" in vcs ? (vcs.unsupportedReason ?? null) : null;
}

/** Unknown status retains the original controls; only an explicit unsupported reason blocks them. */
export function supportsVcsActions(
  status: Pick<VcsStatusLocalResult, "vcs"> | null | undefined,
): boolean {
  return resolveVcsUnsupportedReason(status) === null;
}

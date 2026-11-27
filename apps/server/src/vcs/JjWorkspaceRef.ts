// @effect-diagnostics nodeBuiltinImport:off - the workspace name helpers are pure, so they cannot
// take an injected service.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";

import { VcsUnsupportedOperationError } from "@t3tools/contracts";
import { localBookmarkRevset } from "./JjRevset.ts";
import type { JjSegmentRow, JjVcsDriverShape, JjWorkspace } from "./JjVcsDriver.ts";

const WORKSPACE_NAME_PREFIX = "t3-";
const WORKSPACE_DIGEST_LENGTH = 8;
const WORKSPACE_NAME_PATTERN = new RegExp(
  `^${WORKSPACE_NAME_PREFIX}.+-[0-9a-f]{${WORKSPACE_DIGEST_LENGTH}}$`,
);

export function bookmarkDigest(refName: string): string {
  return NodeCrypto.createHash("sha256")
    .update(refName)
    .digest("hex")
    .slice(0, WORKSPACE_DIGEST_LENGTH);
}

/**
 * `t3-<bookmark with "/" → "-">-<8 hex of sha256(bookmark)>`. The digest is not decoration:
 * without it `a/b` and `a-b` both map to `t3-a-b`, the second `jj workspace add` fails on the
 * duplicate name, and `listRefs` attributes one workspace root to two bookmarks.
 */
export function workspaceNameForRef(refName: string): string {
  return `${WORKSPACE_NAME_PREFIX}${refName.replaceAll("/", "-")}-${bookmarkDigest(refName)}`;
}

/** True for any name {@link workspaceNameForRef} could have produced. Never true for `default`. */
export function isT3WorkspaceName(name: string): boolean {
  return WORKSPACE_NAME_PATTERN.test(name);
}

/** Newest-first segment order makes the first eligible bookmarked row the nearest ancestor. */
export function refNameFromSegment(
  segment: ReadonlyArray<JjSegmentRow>,
  excludedManagedWorkspaces?: ReadonlySet<string>,
): string | null {
  for (const row of segment) {
    if (row !== undefined && row.localBookmarks.length > 0) {
      let selected: string | null = null;
      for (const bookmark of row.localBookmarks) {
        if (excludedManagedWorkspaces?.has(workspaceNameForRef(bookmark))) continue;
        if (selected === null || bookmark < selected) selected = bookmark;
      }
      if (selected !== null) return selected;
    }
  }
  return null;
}

function refNameFromWorkspaceSegment(
  segment: ReadonlyArray<JjSegmentRow>,
  workspaceName: string,
): string | null {
  if (!isT3WorkspaceName(workspaceName)) {
    return refNameFromSegment(segment);
  }
  // A deleted thread bookmark must not redirect writes onto another bookmark such as main.
  for (const row of segment) {
    const bookmark = row.localBookmarks.find((name) => workspaceNameForRef(name) === workspaceName);
    if (bookmark !== undefined) return bookmark;
  }
  return null;
}

export const resolveWorkspaceRefName = Effect.fn("JjWorkspaceRef.resolveWorkspaceRefName")(
  function* (
    driver: Pick<
      JjVcsDriverShape,
      "repoPaths" | "listWorkspaces" | "changeAt" | "listBookmarks" | "countRevset"
    >,
    cwd: string,
    segment: ReadonlyArray<JjSegmentRow>,
    knownWorkspaces?: ReadonlyArray<JjWorkspace>,
    knownDescendants?: ReadonlyArray<JjSegmentRow>,
  ) {
    const paths = yield* driver.repoPaths(cwd);
    const workspaces = knownWorkspaces ?? (yield* driver.listWorkspaces(cwd));
    const workspace = workspaces.find((entry) => entry.root === paths.workspaceRoot);
    if (workspace === undefined) return null;
    if (isT3WorkspaceName(workspace.name)) {
      return refNameFromWorkspaceSegment(segment, workspace.name);
    }
    // Child bookmarks can share the parent's revision without becoming the parent's current ref.
    const otherManagedWorkspaces = new Set<string>();
    for (const entry of workspaces) {
      if (entry.name !== workspace.name && isT3WorkspaceName(entry.name)) {
        otherManagedWorkspaces.add(entry.name);
      }
    }
    // The combined status read excludes @, so an empty descendant set only avoids the full
    // eligible-root query when @ itself cannot have ambiguous eligible bookmark names.
    if (knownDescendants !== undefined && knownDescendants.length === 0) {
      const currentNames =
        segment[0]?.localBookmarks.filter(
          (name) => !otherManagedWorkspaces.has(workspaceNameForRef(name)),
        ) ?? [];
      if (currentNames.length <= 1) return refNameFromSegment(segment, otherManagedWorkspaces);
    }
    // Select only eligible local names before finding roots; managed workspaces cannot hide a
    // farther eligible descendant. Multiple roots or names are ambiguous, never a trunk fallback.
    let eligibleRevset = "bookmarks()";
    if (otherManagedWorkspaces.size > 0) {
      const eligible = (yield* driver.listBookmarks(cwd)).filter(
        (bookmark) =>
          bookmark.remote === null &&
          !otherManagedWorkspaces.has(workspaceNameForRef(bookmark.name)),
      );
      if (eligible.length === 0) return refNameFromSegment(segment, otherManagedWorkspaces);
      eligibleRevset = eligible.map((bookmark) => localBookmarkRevset(bookmark.name)).join(" | ");
    }
    const revset = `roots(@:: & (${eligibleRevset}))`;
    const count = yield* driver.countRevset(cwd, revset);
    const descendant = count === 1 ? yield* driver.changeAt(cwd, revset) : null;
    const names =
      descendant?.localBookmarks.filter(
        (name) => !otherManagedWorkspaces.has(workspaceNameForRef(name)),
      ) ?? [];
    if (count > 1 || names.length > 1) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjWorkspaceRef.resolveWorkspaceRefName",
        kind: "jj",
        detail:
          "Ambiguous descendant bookmarks. Switch to the intended bookmark before continuing.",
      });
    }
    if (names.length === 1) return names[0]!;
    return refNameFromSegment(segment, otherManagedWorkspaces);
  },
);

/**
 * Work the agent committed but never bookmarked: every row of the segment below `@`. `jj new`
 * would hide it from `listRefs` and from the segment query alike, so switching away and removing
 * a workspace both have to refuse over it.
 */
export function strandedSegmentRows(
  segment: ReadonlyArray<JjSegmentRow>,
): ReadonlyArray<JjSegmentRow> {
  return segment.slice(0, -1).filter((row) => !row.empty && row.localBookmarks.length === 0);
}

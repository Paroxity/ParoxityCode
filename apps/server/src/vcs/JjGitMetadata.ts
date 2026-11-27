import * as Effect from "effect/Effect";

import { STATUS_UPSTREAM_REFRESH_ENV } from "./GitVcsDriverCore.ts";
import * as JjProcess from "./JjProcess.ts";
import type * as VcsProcess from "./VcsProcess.ts";

/**
 * Per-bookmark keys in the colocated `.git/config`. A jj bookmark is `refs/heads/<name>` there, so
 * the Git-side hosting and review code reads these back unchanged.
 */
export type BookmarkConfigKey =
  | "remote"
  | "merge"
  | "gh-merge-base"
  | "t3-merge-base-ref"
  | "t3code-imported-pr-head";

/** The keys that describe where a bookmark came from and where it merges; a rename moves them. */
export const BOOKMARK_LINEAGE_KEYS = [
  "remote",
  "merge",
  "gh-merge-base",
  "t3-merge-base-ref",
] as const satisfies ReadonlyArray<BookmarkConfigKey>;

export const bookmarkConfigKey = (bookmark: string, key: BookmarkConfigKey) =>
  `branch.${bookmark}.${key}`;

/** Background fetches write here, a namespace jj does not import, so local bookmarks never move. */
export const privateRemoteRefPrefix = (remoteName: string) =>
  `refs/t3/remotes/${encodeURIComponent(remoteName)}/`;

export const privateRemoteRef = (remoteName: string, branch: string) =>
  `${privateRemoteRefPrefix(remoteName)}${branch}`;

export interface ColocatedGitPaths {
  readonly gitDir: string;
  readonly cwd: string;
}

/** Fetch every branch of `remoteName` into its private refs without touching remote-tracking refs. */
export const fetchPrivateRemoteRefs = (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  paths: ColocatedGitPaths,
  remoteName: string,
  timeoutMs: number,
) =>
  JjProcess.colocatedGitCommand(
    process,
    operation,
    paths,
    [
      // `--refmap=` disables the remote's configured opportunistic remote-tracking updates too.
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--prune",
      "--refmap=",
      "--",
      remoteName,
      `+refs/heads/*:${privateRemoteRefPrefix(remoteName)}*`,
    ],
    { env: STATUS_UPSTREAM_REFRESH_ENV, timeoutMs },
  );

const CONFIG_TIMEOUT_MS = 10_000;

/** The configured value, or `""` when it is unset or unreadable. */
export const readBookmarkConfig = (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  paths: ColocatedGitPaths,
  bookmark: string,
  key: BookmarkConfigKey,
) =>
  JjProcess.colocatedGitCommand(
    process,
    operation,
    paths,
    ["config", "--get", bookmarkConfigKey(bookmark, key)],
    { allowNonZeroExit: true, timeoutMs: CONFIG_TIMEOUT_MS },
  ).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")),
    Effect.orElseSucceed(() => ""),
  );

/** Best effort: the metadata is advisory, so a failed write never fails the jj operation. */
export const writeBookmarkConfig = (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  paths: ColocatedGitPaths,
  bookmark: string,
  key: BookmarkConfigKey,
  value: string,
) =>
  JjProcess.colocatedGitCommand(
    process,
    operation,
    paths,
    ["config", bookmarkConfigKey(bookmark, key), value],
    { allowNonZeroExit: true, timeoutMs: CONFIG_TIMEOUT_MS },
  ).pipe(Effect.ignore);

export const unsetBookmarkConfig = (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  paths: ColocatedGitPaths,
  bookmark: string,
  key: BookmarkConfigKey,
) =>
  JjProcess.colocatedGitCommand(
    process,
    operation,
    paths,
    ["config", "--unset", bookmarkConfigKey(bookmark, key)],
    { allowNonZeroExit: true, timeoutMs: CONFIG_TIMEOUT_MS },
  ).pipe(Effect.ignore);

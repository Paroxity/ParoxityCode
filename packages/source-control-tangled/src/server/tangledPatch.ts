import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { structuredPatch } from "diff";
import * as Effect from "effect/Effect";

import type * as TangledApi from "./TangledApi.ts";

/**
 * Tangled's diff API answers with structural hunks and no file text, so T3 builds git's unified
 * form itself from the two blobs. Each page stops at a file and byte budget, and a file past its
 * own edit or byte budget shows only its header.
 */
const FILES_PER_PAGE = 25;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SECTION_BYTES = 512 * 1024;
const MAX_SLICE_BYTES = 256 * 1024;
const MAX_SLICE_EDITS = 6_000;
const MAX_FILE_EDITS = 2_000;
const MAX_FILE_DIFF_MILLIS = 2_000;
const CONTEXT_LINES = 3;
const ABSENT = /^0+$/u;

/** A commit range across two repositories: a fork's head is only in the fork. */
export interface TangledRange {
  readonly baseRepoDid: string;
  readonly base: string;
  readonly headRepoDid: string;
  readonly head: string;
}

type Round = Pick<TangledApi.TangledRound, "baseOid" | "headOid" | "sourceRepoDid">;

/** What a diff read compares: a commit range, or Tangled's interdiff of two rounds. */
export type TangledComparison =
  | { readonly kind: "range"; readonly range: TangledRange }
  | { readonly kind: "interdiff"; readonly from: Round; readonly to: Round };

export type FileChange = "added" | "deleted" | "modified";

interface FilePaths {
  readonly oldPath: string;
  readonly newPath: string;
  readonly change: FileChange;
}

interface FilePatch {
  readonly section: string;
  readonly truncated: boolean;
  readonly edits: number;
}

const changeOf = (file: TangledApi.TangledFileDiff): FileChange =>
  ABSENT.test(file.lhsSrc.oid) ? "added" : ABSENT.test(file.rhsSrc.oid) ? "deleted" : "modified";

const pathsOf = (file: TangledApi.TangledFileDiff): FilePaths => ({
  oldPath: file.lhsSrc.path,
  newPath: file.rhsSrc.path,
  change: changeOf(file),
});

/** Changed lines per file as Tangled counts them, without reading any blob. */
export const lineStats = (file: TangledApi.TangledFileDiff) => ({
  additions: file.hunks.reduce((sum, hunk) => sum + hunk.novelRhs.length, 0),
  deletions: file.hunks.reduce((sum, hunk) => sum + hunk.novelLhs.length, 0),
});

const unreadable = (file: TangledApi.TangledFileDiff) =>
  file.lhsSrc.isBinary ||
  file.rhsSrc.isBinary ||
  file.lhsSrc.isSubmodule === true ||
  file.rhsSrc.isSubmodule === true ||
  Math.max(file.lhsSrc.size, file.rhsSrc.size) > MAX_FILE_BYTES;

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/** Git anchors an empty range at the line before it, which may be zero. */
const hunkRange = (start: number, lines: number) =>
  lines === 0 ? `${start - 1},0` : lines === 1 ? String(start) : `${start},${lines}`;

/** Tangled reports no modes, so files read as regular ones. */
function header(paths: FilePaths): string {
  const oldSide = quoteGitPatchPath(`a/${paths.oldPath}`);
  const newSide = quoteGitPatchPath(`b/${paths.newPath}`);
  const lines = [`diff --git ${oldSide} ${newSide}`];
  if (paths.change === "added") lines.push("new file mode 100644");
  if (paths.change === "deleted") lines.push("deleted file mode 100644");
  if (paths.change === "modified" && paths.oldPath !== paths.newPath)
    lines.push(
      "similarity index 0%",
      `rename from ${quoteGitPatchPath(paths.oldPath)}`,
      `rename to ${quoteGitPatchPath(paths.newPath)}`,
    );
  lines.push(
    `--- ${paths.change === "added" ? "/dev/null" : oldSide}`,
    `+++ ${paths.change === "deleted" ? "/dev/null" : newSide}`,
  );
  return lines.join("\n");
}

const headerOnly = (paths: FilePaths, edits = 0): FilePatch => ({
  section: `${header(paths)}\n`,
  truncated: true,
  edits,
});

const binaryPatch = (paths: FilePaths): FilePatch => {
  const oldSide = quoteGitPatchPath(`a/${paths.oldPath}`);
  const newSide = quoteGitPatchPath(`b/${paths.newPath}`);
  return {
    section: `${header(paths)}\nBinary files ${oldSide} and ${newSide} differ\n`,
    truncated: true,
    edits: 0,
  };
};

/** One file's `diff --git` section; empty when an unrenamed file's text did not change. */
export function filePatch(paths: FilePaths, oldContents: string, newContents: string): FilePatch {
  const renamed = paths.oldPath !== paths.newPath;
  const patch = structuredPatch(
    paths.oldPath,
    paths.newPath,
    paths.change === "added" ? "" : oldContents,
    paths.change === "deleted" ? "" : newContents,
    undefined,
    undefined,
    { context: CONTEXT_LINES, maxEditLength: MAX_FILE_EDITS, timeout: MAX_FILE_DIFF_MILLIS },
  );
  // Past the edit budget a full replacement would bury what changed.
  if (patch === undefined) return headerOnly(paths, MAX_FILE_EDITS);
  if (patch.hunks.length === 0 && paths.change === "modified" && !renamed)
    return { section: "", truncated: false, edits: 0 };
  let edits = 0;
  const hunks = patch.hunks.map((hunk) => {
    for (const line of hunk.lines) if (line.startsWith("+") || line.startsWith("-")) edits += 1;
    return [
      `@@ -${hunkRange(hunk.oldStart, hunk.oldLines)} +${hunkRange(hunk.newStart, hunk.newLines)} @@`,
      ...hunk.lines,
    ].join("\n");
  });
  const head = header(paths);
  const section = hunks.length === 0 ? `${head}\n` : `${head}\n${hunks.join("\n")}\n`;
  // Long lines can pass the edit budget and still be too large to send.
  if (byteLength(section) > MAX_SECTION_BYTES) return headerOnly(paths, edits);
  return { section, truncated: false, edits };
}

export const listFiles = (api: TangledApi.TangledApi["Service"], comparison: TangledComparison) =>
  comparison.kind === "interdiff"
    ? api.getInterdiff({ from: comparison.from, to: comparison.to })
    : api.getDiff({
        baseRepoDid: comparison.range.baseRepoDid,
        baseCommit: comparison.range.base,
        headRepoDid: comparison.range.headRepoDid,
        headCommit: comparison.range.head,
      });

const headBlob = (api: TangledApi.TangledApi["Service"], to: Round, path: string) =>
  api.getBlob({ repoDid: to.sourceRepoDid, commit: to.headOid, path });

const rangeContents = (
  api: TangledApi.TangledApi["Service"],
  range: TangledRange,
  file: FilePaths,
) =>
  Effect.all(
    [
      file.change === "added"
        ? Effect.succeed("")
        : api.getBlob({ repoDid: range.baseRepoDid, commit: range.base, path: file.oldPath }),
      file.change === "deleted"
        ? Effect.succeed("")
        : api.getBlob({ repoDid: range.headRepoDid, commit: range.head, path: file.newPath }),
    ],
    { concurrency: 2 },
  );

/** The interdiff's left side is a tree no ref names, so its text exists only inline. */
const interdiffContents = (
  api: TangledApi.TangledApi["Service"],
  to: Round,
  file: TangledApi.TangledFileDiff,
) => {
  const change = changeOf(file);
  return Effect.all([
    Effect.succeed(change === "added" ? "" : (file.lhsSrc.content ?? null)),
    change === "deleted" ? Effect.succeed("") : headBlob(api, to, file.rhsSrc.path),
  ]);
};

const contentsOf = (
  api: TangledApi.TangledApi["Service"],
  comparison: TangledComparison,
  file: TangledApi.TangledFileDiff,
) =>
  comparison.kind === "interdiff"
    ? interdiffContents(api, comparison.to, file)
    : rangeContents(api, comparison.range, pathsOf(file));

/** Null contents mean a side too large or binary to show. */
export const readFileContents = Effect.fn("TangledPatch.readFileContents")(function* (
  api: TangledApi.TangledApi["Service"],
  comparison: TangledComparison,
  file: FilePaths,
) {
  if (comparison.kind === "range") {
    const [oldContents, newContents] = yield* rangeContents(api, comparison.range, file);
    return { oldContents, newContents };
  }
  const files = yield* listFiles(api, comparison);
  const found = files.find(
    (candidate) => candidate.lhsSrc.path === file.oldPath && candidate.rhsSrc.path === file.newPath,
  );
  if (found === undefined) {
    // A file the interdiff leaves out is unchanged since the earlier round.
    const unchanged = yield* headBlob(api, comparison.to, file.newPath);
    return { oldContents: unchanged, newContents: unchanged };
  }
  const [oldContents, newContents] = yield* interdiffContents(api, comparison.to, found);
  return { oldContents, newContents };
});

/**
 * Unified diff text for one page of a comparison's files. `truncated` is set when a file was too
 * large or binary to show its lines; a page ends early once it holds its budget.
 */
export const readPatchSlice = Effect.fn("TangledPatch.readPatchSlice")(function* (
  api: TangledApi.TangledApi["Service"],
  comparison: TangledComparison,
  cursor: string | undefined,
) {
  const files = yield* listFiles(api, comparison);
  const offset = cursor === undefined ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
  const page = files.slice(offset, offset + FILES_PER_PAGE);
  const patches = yield* Effect.forEach(
    page,
    Effect.fnUntraced(function* (file) {
      const paths = pathsOf(file);
      if (unreadable(file)) return binaryPatch(paths);
      const [oldContents, newContents] = yield* contentsOf(api, comparison, file);
      if (oldContents === null || newContents === null) return binaryPatch(paths);
      return filePatch(paths, oldContents, newContents);
    }),
    // fnUntraced: one span per file of a page would drown the page's own span.
    { concurrency: 8 },
  );
  let bytes = 0;
  let edits = 0;
  let taken = 0;
  for (const patch of patches) {
    const size = byteLength(patch.section);
    if (taken > 0 && (bytes + size > MAX_SLICE_BYTES || edits + patch.edits > MAX_SLICE_EDITS))
      break;
    bytes += size;
    edits += patch.edits;
    taken += 1;
  }
  const included = patches.slice(0, taken);
  const next = offset + taken;
  return {
    patch: included.map((patch) => patch.section).join(""),
    truncated: included.some((patch) => patch.truncated),
    nextCursor: next < files.length ? String(next) : null,
  };
});

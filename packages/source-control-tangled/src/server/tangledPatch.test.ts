import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fakeTangled, type RecordedRequest } from "./fakeTangled.ts";
import * as TangledApi from "./TangledApi.ts";
import { filePatch, readPatchSlice, type FileChange } from "./tangledPatch.ts";

const paths = (change: FileChange, oldPath = "src/a.ts", newPath = oldPath) => ({
  oldPath,
  newPath,
  change,
});

const numbered = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join("");

describe("filePatch", () => {
  it("writes git's hunks with three lines of context and merges nearby changes", () => {
    const before = numbered(20);
    const after = before
      .replace("line 5\n", "line five\n")
      .replace("line 9\n", "")
      .replace("line 20\n", "line 20\nline 21\n");
    const patch = filePatch(paths("modified"), before, after);
    expect(patch.section).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -2,11 +2,10 @@",
        " line 2",
        " line 3",
        " line 4",
        "-line 5",
        "+line five",
        " line 6",
        " line 7",
        " line 8",
        "-line 9",
        " line 10",
        " line 11",
        " line 12",
        "@@ -18,3 +17,4 @@",
        " line 18",
        " line 19",
        " line 20",
        "+line 21",
        "",
      ].join("\n"),
    );
    expect(patch.edits).toBe(4);
  });

  it("marks added and deleted files and a missing final newline", () => {
    expect(filePatch(paths("added"), "", "one\ntwo").section).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/a.ts",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    expect(filePatch(paths("deleted"), "gone\n", "").section).toContain(
      "deleted file mode 100644\n--- a/src/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n",
    );
    expect(filePatch(paths("modified"), "same\n", "same").section).toContain(
      "-same\n+same\n\\ No newline at end of file\n",
    );
    expect(filePatch(paths("modified"), "same\n", "same\n").section).toBe("");
  });

  it("keeps a rename, and quotes paths git would quote", () => {
    expect(filePatch(paths("modified", "old.ts", "new.ts"), "x\n", "x\n").section).toBe(
      [
        "diff --git a/old.ts b/new.ts",
        "similarity index 0%",
        "rename from old.ts",
        "rename to new.ts",
        "--- a/old.ts",
        "+++ b/new.ts",
        "",
      ].join("\n"),
    );
    expect(filePatch(paths("added", "tab\there.ts"), "", "x\n").section).toContain(
      'diff --git "a/tab\\there.ts" "b/tab\\there.ts"',
    );
  });

  it("shows only the header of a file past its edit budget", () => {
    const before = Array.from({ length: 3_000 }, (_, i) => `a${i}\n`).join("");
    const after = Array.from({ length: 3_000 }, (_, i) => `b${i}\n`).join("");
    const patch = filePatch(paths("modified"), before, after);
    expect(patch.truncated).toBe(true);
    expect(patch.section).not.toContain("@@");
  });
});

describe("readPatchSlice", () => {
  const REPO = "did:plc:slicerepoaaaaaaaaaaaaaaa";
  const side = (path: string, oid: string, size: number) => ({
    path,
    oid,
    size,
    isBinary: false,
  });
  const range = {
    kind: "range" as const,
    range: { baseRepoDid: REPO, base: "a".repeat(40), headRepoDid: REPO, head: "b".repeat(40) },
  };

  it.effect("ends a page at its byte budget and resumes at the next file", () => {
    // Three new files of ~120 KB each: two fit the 256 KB page, so the third starts the next.
    const big = `${"x".repeat(119)}\n`.repeat(1_000);
    const files = ["one", "two", "three"].map((name) => ({
      lhsSrc: side(name, "0".repeat(40), 0),
      rhsSrc: side(name, "c".repeat(40), big.length),
      hunks: [],
    }));
    const fake = fakeTangled({
      "sh.tangled.git.temp2.getDiff": { diffs: files },
      "org.tangled.temp.git.getBlob": (_request: RecordedRequest) => ({ body: big }),
    });
    return Effect.gen(function* () {
      const api = yield* TangledApi.TangledApi;
      const first = yield* readPatchSlice(api, range, undefined);
      assert.strictEqual(first.nextCursor, "2");
      assert.strictEqual(first.patch.match(/^diff --git/gmu)?.length, 2);
      const second = yield* readPatchSlice(api, range, first.nextCursor ?? undefined);
      assert.strictEqual(second.nextCursor, null);
      assert.include(second.patch, "diff --git a/three b/three");
      assert.strictEqual(
        fake.calls("sh.tangled.git.temp2.getDiff").length,
        1,
        "the second page reuses the first page's diff",
      );
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("names a binary or oversized file without reading it", () => {
    const fake = fakeTangled({
      "sh.tangled.git.temp2.getDiff": {
        diffs: [
          {
            lhsSrc: { ...side("logo.png", "d".repeat(40), 10), isBinary: true },
            rhsSrc: { ...side("logo.png", "e".repeat(40), 12), isBinary: true },
            hunks: [],
          },
          {
            lhsSrc: side("huge.json", "d".repeat(40), 2 * 1024 * 1024),
            rhsSrc: side("huge.json", "e".repeat(40), 2 * 1024 * 1024),
            hunks: [],
          },
        ],
      },
    });
    return Effect.gen(function* () {
      const api = yield* TangledApi.TangledApi;
      const slice = yield* readPatchSlice(api, range, undefined);
      assert.isTrue(slice.truncated);
      assert.include(slice.patch, "Binary files a/logo.png and b/logo.png differ");
      assert.include(slice.patch, "Binary files a/huge.json and b/huge.json differ");
      assert.deepStrictEqual(fake.calls("org.tangled.temp.git.getBlob"), []);
    }).pipe(Effect.provide(fake.layer));
  });
});

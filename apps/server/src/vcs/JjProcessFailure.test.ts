import { assert, describe, it } from "@effect/vitest";
import {
  GitCommandError,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type GitCommandFailureReason,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import {
  colocatedGitCommand,
  JJ_STALE_WORKSPACE_DETAIL,
  jjCommand,
  jjFailure,
  JjProcessExitError,
  mapJjFailure,
} from "./JjProcess.ts";
import * as VcsProcess from "./VcsProcess.ts";

const encodeError = Schema.encodeEffect(Schema.fromJsonString(GitCommandError));
const cases: ReadonlyArray<readonly [string, GitCommandFailureReason | undefined]> = [
  [
    "Error: authentication failed for https://token:secret@example.com/repo",
    "authentication_failed",
  ],
  ["git@example.com: Permission denied (publickey).", "authentication_failed"],
  [
    "knot: this ssh key doesn't match any key published by the accounts that may push here.\nfatal: the remote end hung up unexpectedly",
    "authentication_failed",
  ],
  ["Host key verification failed.", "host_key_unverified"],
  ["fatal: Could not read from remote repository.", "remote_unreachable"],
  ["remote: authentication failed for secret", undefined],
  ["hook says authentication failed for secret", undefined],
  ["Error: unrelated failure for secret", undefined],
];

it.effect("preserves nested unsupported detail instead of workspace wrapper messages", () =>
  Effect.gen(function* () {
    const detail = "Run `jj git colocation enable` in this repository.";
    const unsupported = new VcsUnsupportedOperationError({
      operation: "ensureUsable",
      kind: "jj",
      detail,
    });
    const nested = jjFailure("inner", "/repo", "Inner wrapper.", unsupported);
    const failure = jjFailure("outer", "/repo", "Outer wrapper.", nested);
    const codec = Schema.toCodecJson(GitCommandError);
    const wire = yield* Schema.encodeEffect(codec)(failure);
    const decoded = yield* Schema.decodeUnknownEffect(codec)(JSON.parse(JSON.stringify(wire)));
    assert.equal(decoded.reason, "unsupported_repository");
    assert.equal(decoded.detail, detail);
  }),
);

it("does not classify ordinary errors by their message", () => {
  const failure = jjFailure(
    "createWorktree",
    "/repo",
    "Could not create workspace.",
    new Error("VcsUnsupportedOperationError: Run jj git colocation enable"),
  );
  assert.isUndefined(failure.reason);
  assert.equal(failure.detail, "Could not create workspace.");
});

describe.each(["jj", "git"] as const)("%s failure reasons", (command) => {
  it.effect.each(cases)("classifies %s without exposing diagnostics", ([stderr, reason]) =>
    Effect.gen(function* () {
      const process: VcsProcess.VcsProcess["Service"] = {
        run: () =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(1),
            stdout: "",
            stderr: command === "git" ? stderr.replace(/^Error:/, "error:") : stderr,
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      };
      const result =
        command === "jj"
          ? jjCommand(process, "fetch", "/repo", ["git", "fetch"])
          : colocatedGitCommand(process, "fetch", { gitDir: "/repo/.git", cwd: "/repo" }, [
              "fetch",
            ]);
      const error = yield* result.pipe(
        mapJjFailure("fetch", "/repo", "Could not fetch."),
        Effect.flip,
      );
      assert.equal(error.reason, reason);
      const encoded = yield* encodeError(error);
      assert.notInclude(encoded, "secret");
      assert.notInclude(encoded, stderr);
    }),
  );

  it.effect("preserves explicitly allowed nonzero exits", () =>
    Effect.gen(function* () {
      const process: VcsProcess.VcsProcess["Service"] = {
        run: () =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(1),
            stdout: "",
            stderr: "fatal: authentication failed",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      };
      const options = { allowNonZeroExit: true };
      const result = yield* command === "jj"
        ? jjCommand(process, "fetch", "/repo", ["git", "fetch"], options)
        : colocatedGitCommand(
            process,
            "fetch",
            { gitDir: "/repo/.git", cwd: "/repo" },
            ["fetch"],
            options,
          );
      assert.equal(result.exitCode, 1);
    }),
  );
});

describe("jj process failure boundaries", () => {
  it.effect.each([
    ["Error: Revision `missing` doesn't exist", "not-found"],
    ["Error: Function `trnk` doesn't exist", "command-failed"],
    ['Error: There is no jj repo in "/repo"', "command-failed"],
    ["Error: authentication failed", "authentication"],
  ] as const)("classifies changeAt failure $0", ([stderr, expectedKind]) =>
    Effect.gen(function* () {
      const process: VcsProcess.VcsProcess["Service"] = {
        run: () =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(1),
            stdout: "",
            stderr,
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      };
      const error = yield* jjCommand(
        process,
        "arbitrary.read.operation",
        "/repo",
        ["log", "-r", "trnk()"],
        { readingChange: true },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "VcsProcessExitError");
      if (error._tag === "VcsProcessExitError") {
        assert.equal(error.failureKind, expectedKind);
      }
    }),
  );
});

describe("jjFailure", () => {
  it("preserves structured reasons through nested jj and colocated Git failures", () => {
    for (const cause of [
      new GitCommandError({
        operation: "git.fetch",
        command: "git",
        cwd: "/repo",
        detail: "Git command failed.",
        reason: "host_key_unverified",
      }),
      new JjProcessExitError({
        ...new VcsProcessExitError({
          operation: "jj.fetch",
          command: "jj",
          cwd: "/repo",
          exitCode: 1,
          detail: "Command failed.",
        }),
        reason: "host_key_unverified",
      }),
    ]) {
      const inner = jjFailure("inner", "/repo", "Could not fetch.", cause);
      const outer = jjFailure("outer", "/repo", "Could not update repository.", inner);
      assert.equal(outer.reason, "host_key_unverified");
      assert.equal(outer.detail, "Could not update repository.");
      assert.equal(outer.cause, inner);
    }
  });

  it.effect("keeps raw diagnostics out of mapped errors", () =>
    Effect.gen(function* () {
      const secret = "https://token:super-secret@example.com/private.git";
      const cause = new JjProcessExitError({
        ...VcsProcessExitError.fromProcessExit(
          { operation: "fetch", command: "jj", cwd: "/repo", argumentCount: 2 },
          {
            exitCode: 1,
            stderr: `Error: authentication failed for ${secret}`,
            stderrTruncated: false,
          },
          "authentication",
        ),
        reason: "authentication_failed",
      });
      const error = yield* Effect.fail(cause).pipe(
        mapJjFailure("fetch", "/repo", "Could not fetch remote."),
        Effect.flip,
      );
      assert.equal(error.reason, "authentication_failed");
      assert.equal(error.detail, "Could not fetch remote.");
      assert.notInclude(yield* encodeError(error), secret);
    }),
  );

  it("surfaces a stale workspace in place of the caller's generic detail", () => {
    const stale = new JjProcessExitError({
      ...VcsProcessExitError.fromProcessExit(
        { operation: "status", command: "jj", cwd: "/repo", argumentCount: 1 },
        { exitCode: 1, stderr: "", stderrTruncated: false },
        "command-failed",
      ),
      detail: JJ_STALE_WORKSPACE_DETAIL,
      staleWorkspace: true,
    });
    const inner = jjFailure("inner", "/repo", "Could not read the working-copy snapshot.", stale);
    const outer = jjFailure("outer", "/repo", "Could not commit this change.", inner);
    assert.equal(outer.detail, JJ_STALE_WORKSPACE_DETAIL);
  });

  it("does not infer a reason from arbitrary cause text", () => {
    const error = jjFailure(
      "fetch",
      "/repo",
      "Could not fetch.",
      new Error("authentication failed"),
    );
    assert.equal(error.reason, undefined);
    assert.equal(jjFailure("fetch", "/repo", "Could not fetch.").reason, undefined);
  });
});

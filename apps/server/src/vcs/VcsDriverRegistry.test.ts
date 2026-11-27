import { assert, it, describe } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import {
  VcsProcessExitError,
  CheckpointRef,
  ThreadId,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";

import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import {
  describeJj,
  seedJjRepo,
  runGit,
  runJj,
  unusedJjCheckpoints,
} from "./testing/JjTestSupport.ts";
import { invalidateJjAvailability } from "./JjAvailability.ts";
import { isGitLinkedWorktree } from "./JjRepo.ts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as SourceControlDiscovery from "../sourceControl/SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const normalizeGitArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args[0] === "-C" && args.length >= 2 ? args.slice(2) : args;

const DETECT_COMMAND = "rev-parse --is-inside-work-tree --show-toplevel --git-common-dir";

describe("VcsDriverRegistry", () => {
  const makeDiskBackedLayer = (rootDir: string, calls: string[]) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(JjVcsDriver.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const command = normalizeGitArgs(input.args).join(" ");
              calls.push(command);
              let repoDir: string | null = input.cwd;
              while (repoDir !== null && !(yield* fs.exists(path.join(repoDir, ".git")))) {
                repoDir = repoDir === rootDir ? null : path.dirname(repoDir);
              }
              if (repoDir === null) {
                return {
                  ...processOutput(""),
                  exitCode: ChildProcessSpawner.ExitCode(128),
                  stderr: "fatal: not a git repository",
                };
              }
              if (command === DETECT_COMMAND) {
                return processOutput(
                  `true\n${repoDir}\n${path.relative(input.cwd, path.join(repoDir, ".git"))}\n`,
                );
              }
              return processOutput("");
            }).pipe(
              Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
              Effect.orDie,
            ),
        }),
      ),
    );

  it.effect("skips plain Git facade detection without spawning processes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-facade-" });
      yield* fs.makeDirectory(path.join(root, ".git"));
      const calls: string[] = [];
      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.isNull(yield* registry.detect({ cwd: root, jjOnly: true }));
        assert.isEmpty(calls);
      }).pipe(Effect.provide(makeDiskBackedLayer(root, calls)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  describeJj("facade jj detection", () => {
    it.effect("selects a real jj repository", () =>
      Effect.gen(function* () {
        const { root } = yield* seedJjRepo({ prefix: "t3-vcs-facade-jj-" });
        yield* Effect.gen(function* () {
          const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
          assert.equal((yield* registry.detect({ cwd: root, jjOnly: true }))?.kind, "jj");
        }).pipe(Effect.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))));
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );
  });

  it.effect("detects again when a cached repository is removed from disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      yield* fs.makeDirectory(path.join(repoDir, ".git"));
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);

        yield* fs.remove(path.join(repoDir, ".git"), { recursive: true });

        assert.equal(yield* registry.detect({ cwd: repoDir }), null);
        assert.equal(calls.filter((call) => call === DETECT_COMMAND).length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("detects again when git init creates a repository inside a cached one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      yield* fs.makeDirectory(path.join(parentDir, ".git"));
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        for (const [repoRel, cwdRel] of [
          ["project", "project"],
          ["..cache", path.join("..cache", "sub")],
        ] as const) {
          const nestedRepoDir = path.join(parentDir, repoRel);
          const cwd = path.join(parentDir, cwdRel);
          yield* fs.makeDirectory(cwd, { recursive: true });

          assert.equal((yield* registry.detect({ cwd }))?.repository.rootPath, parentDir);

          yield* fs.makeDirectory(path.join(nestedRepoDir, ".git"));

          assert.equal((yield* registry.detect({ cwd }))?.repository.rootPath, nestedRepoDir);
        }
      }).pipe(Effect.provide(makeDiskBackedLayer(parentDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("detects a repository created after a negative lookup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal(yield* registry.detect({ cwd: repoDir }), null);

        yield* fs.makeDirectory(path.join(repoDir, ".git"));

        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);
        assert.equal(calls.filter((call) => call === DETECT_COMMAND).length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
  const makeFailingLayer = (detectOutput: VcsProcess.VcsProcessOutput) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(JjVcsDriver.layer),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            normalizeGitArgs(input.args).join(" ") === DETECT_COMMAND
              ? Effect.succeed(detectOutput)
              : Effect.fail(
                  new VcsProcessExitError({
                    operation: input.operation,
                    command: "git",
                    cwd: input.cwd,
                    exitCode: 128,
                    detail: "fatal: bad config line 1 in file .git/config",
                  }),
                ),
        }),
      ),
    );

  it.effect("reads only a failed work-tree probe as no repository", () =>
    Effect.gen(function* () {
      const probeFailure = yield* VcsDriverRegistry.VcsDriverRegistry.pipe(
        Effect.flatMap((registry) => registry.detect({ cwd: "/repo" })),
        Effect.provide(
          makeFailingLayer({
            ...processOutput(""),
            exitCode: ChildProcessSpawner.ExitCode(128),
            stderr: "fatal: bad config line 1 in file .git/config",
          }),
        ),
      );
      assert.equal(probeFailure, null);

      // A newline in the root path makes detection ask for it again, and main surfaced that failure.
      const fallbackFailure = yield* VcsDriverRegistry.VcsDriverRegistry.pipe(
        Effect.flatMap((registry) => registry.detect({ cwd: "/repo" })),
        Effect.provide(makeFailingLayer(processOutput("true\n/re\npo\n.git\n"))),
        Effect.flip,
      );
      assert.equal(fallbackFailure._tag, "VcsProcessExitError");
    }),
  );
});

describe("VcsDriverRegistry jj detection", () => {
  it.effect(
    "auto-detects a colocated workspace as jj, ahead of git, with a cached version probe",
    () => {
      let processCalls = 0;
      const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
        Layer.provide(JjVcsDriver.layer),
        Layer.provide(VcsProjectConfig.layer),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        Layer.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: () =>
              Effect.sync(() => {
                processCalls += 1;
                return processOutput("jj 0.46.0\n");
              }),
          }),
        ),
      );

      return Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const created = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-registry-" });
        const root = yield* fileSystem.realPath(created);
        yield* fileSystem.makeDirectory(path.join(root, ".jj", "repo"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(root, ".git"), { recursive: true });

        assert.isDefined(yield* registry.get("jj"));

        const detected = yield* registry.detect({ cwd: root });
        assert.strictEqual(detected?.kind, "jj");
        assert.strictEqual(detected?.repository.rootPath, root);
        assert.strictEqual(processCalls, 1);
      }).pipe(Effect.provide(layer));
    },
  );

  const makeDiskBackedLayer = (rootDir: string, calls: string[], failJjDetection = false) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(VcsProjectConfig.layer),
      Layer.provide(
        failJjDetection
          ? Layer.mock(JjVcsDriver.JjVcsDriver)({
              checkpoints: unusedJjCheckpoints,
              detectRepository: () =>
                Effect.fail(
                  new VcsUnsupportedOperationError({
                    operation: "test.detect",
                    kind: "jj",
                    detail: "Jujutsu marker lookup failed.",
                  }),
                ),
            })
          : JjVcsDriver.layer,
      ),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const command = normalizeGitArgs(input.args).join(" ");
              if (input.command === "jj") return processOutput("jj 0.46.0\n");
              calls.push(command);
              let repoDir: string | null = input.cwd;
              while (repoDir !== null && !(yield* fs.exists(path.join(repoDir, ".git")))) {
                repoDir = repoDir === rootDir ? null : path.dirname(repoDir);
              }
              if (repoDir === null) {
                return {
                  ...processOutput(""),
                  exitCode: ChildProcessSpawner.ExitCode(128),
                  stderr: "fatal: not a git repository",
                };
              }
              if (command === "rev-parse --is-inside-work-tree --show-toplevel --git-common-dir") {
                const commonDir = path.relative(input.cwd, path.join(repoDir, ".git"));
                return processOutput(`true\n${repoDir}\n${commonDir}\n`);
              }
              if (command === "rev-parse --is-inside-work-tree") return processOutput("true\n");
              if (command === "rev-parse --show-toplevel") return processOutput(`${repoDir}\n`);
              if (command === "rev-parse --git-common-dir") {
                return processOutput(`${path.relative(input.cwd, path.join(repoDir, ".git"))}\n`);
              }
              return processOutput("");
            }).pipe(
              Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
              Effect.orDie,
            ),
        }),
      ),
    );

  it.effect("falls back to Git when the added jj probe fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      yield* fs.makeDirectory(path.join(repoDir, ".git"));
      const calls: string[] = [];
      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const handle = yield* registry.detect({ cwd: repoDir });
        assert.equal(handle?.kind, "git");
        assert.equal(handle?.repository.rootPath, repoDir);
        assert.deepStrictEqual(calls, [
          "rev-parse --is-inside-work-tree --show-toplevel --git-common-dir",
        ]);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls, true)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("detects Jujutsu initialized at a cached Git root from a nested cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const cwd = path.join(repoDir, "src");
      yield* fs.makeDirectory(path.join(repoDir, ".git"));
      yield* fs.makeDirectory(cwd);
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd }))?.kind, "git");

        yield* fs.makeDirectory(path.join(repoDir, ".jj", "repo"), { recursive: true });

        assert.equal((yield* registry.detect({ cwd }))?.kind, "jj");
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

describeJj("VcsDriverRegistry shared jj driver", () => {
  it.effect("keeps an unreadable jj repository pointer as an unsupported jj repository", () =>
    Effect.gen(function* () {
      const { root } = yield* seedJjRepo({ prefix: "t3-jj-unreadable-pointer-", seed: true });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.remove(path.join(root, ".jj", "repo"), { recursive: true });
      yield* fs.symlink("repo", path.join(root, ".jj", "repo"));
      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const driver = yield* JjVcsDriver.JjVcsDriver;
        const detected = yield* registry.resolve({ cwd: root });
        assert.equal(detected.kind, "jj");
        const result = yield* Effect.result(driver.ensureUsable("test", root));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "VcsUnsupportedOperationError");
          if (result.failure._tag === "VcsUnsupportedOperationError") {
            assert.include(
              result.failure.detail,
              "Could not read the Jujutsu workspace repository pointer.",
            );
          }
        }
      }).pipe(Effect.provide(VcsDriverRegistry.layer.pipe(Layer.provideMerge(JjVcsDriver.layer))));
    }).pipe(
      Effect.provide(
        VcsProcess.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
  it.effect("never routes a nested bare Git repository to the outer jj driver", () =>
    Effect.gen(function* () {
      const { root } = yield* seedJjRepo({ prefix: "t3-jj-nested-bare-", seed: true });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bare = path.join(root, "nested.git");
      yield* fs.makeDirectory(path.join(bare, "objects"), { recursive: true });

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.resolve({ cwd: root })).kind, "jj");
        for (const cwd of [bare, path.join(bare, "objects")]) {
          const handle = yield* registry.detect({ cwd });
          assert.equal(handle?.kind, "jj");
          assert.equal(handle?.repository.rootPath, root);
        }
        yield* runGit(root, ["init", "--bare", bare]);
        for (const cwd of [bare, path.join(bare, "objects")]) {
          assert.isNull(yield* registry.detect({ cwd, jjOnly: true }));
          assert.isNull(yield* registry.detect({ cwd }));
          const refusal = yield* registry.resolve({ cwd }).pipe(Effect.flip);
          assert.equal(refusal._tag, "VcsUnsupportedOperationError");
        }
      }).pipe(Effect.provide(VcsDriverRegistry.layer));
    }).pipe(
      Effect.provide(
        VcsProcess.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
  it.effect("keeps Git available when jj is initialized inside a linked Git worktree", () =>
    Effect.gen(function* () {
      const { root, base } = yield* seedJjRepo({ prefix: "t3-jj-linked-git-", seed: true });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktree = path.join(base, "thread-worktree");
      yield* runGit(root, ["worktree", "add", "-b", "thread", worktree, "HEAD"]);
      yield* runJj(worktree, ["git", "init", "--colocate"]);
      assert.equal((yield* fs.stat(path.join(worktree, ".git"))).type, "File");
      assert.equal((yield* fs.stat(path.join(worktree, ".jj", "repo"))).type, "Directory");
      const nested = path.join(worktree, "nested");
      yield* fs.makeDirectory(nested);
      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const handle = yield* registry.resolve({ cwd: nested });
        assert.equal(handle.kind, "git");
        assert.equal(handle.repository.rootPath, worktree);
        assert.include(handle.notice, "Jujutsu inside a Git linked worktree is not supported");
        assert.include(handle.notice, "Using Git");
        assert.notInclude(handle.notice, "colocation enable");
        assert.isTrue(yield* handle.driver.isInsideWorkTree(nested));
      }).pipe(Effect.provide(VcsDriverRegistry.layer));
      const driver = yield* JjVcsDriver.makeJjVcsDriver;
      const refusal = yield* driver
        .ensureUsable("test.pinned-linked-worktree", nested)
        .pipe(Effect.flip);
      if (refusal._tag !== "VcsUnsupportedOperationError") {
        throw new Error(`Unexpected refusal: ${refusal._tag}`);
      }
      assert.include(refusal.detail, "Jujutsu inside a Git linked worktree is not supported");
      assert.notInclude(refusal.detail, "colocation enable");
      const separate = path.join(base, "separate-checkout");
      yield* runGit(base, [
        "init",
        "--separate-git-dir",
        path.join(base, "separate-gitdir"),
        separate,
      ]);
      assert.isFalse(yield* isGitLinkedWorktree(fs, path, separate));
    }).pipe(
      Effect.provide(
        VcsProcess.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
  it.effect(
    "skips jj-only detection without subprocesses for a colocated project-file Git pin",
    () =>
      Effect.gen(function* () {
        const { root } = yield* seedJjRepo({ prefix: "t3-jj-git-pin-probes-", seed: true });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(root, ".t3code"));
        yield* fs.writeFileString(
          path.join(root, ".t3code", "vcs.json"),
          JSON.stringify({ vcs: { kind: "git" } }),
        );
        const realProcess = yield* VcsProcess.VcsProcess;
        const calls: string[] = [];
        const process: VcsProcess.VcsProcess["Service"] = {
          run: (input) => {
            calls.push(`${input.command} ${input.args.join(" ")}`);
            return realProcess.run(input);
          },
        };
        yield* Effect.gen(function* () {
          const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
          const detected = yield* registry.detect({ cwd: root, jjOnly: true });
          assert.deepEqual(calls, []);
          assert.isNull(detected);
        }).pipe(
          Effect.provide(
            VcsDriverRegistry.layer.pipe(
              Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          VcsProcess.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );
  it.effect.each(["git", "jj", "unknown"] as const)(
    "honors the project-file %s pin with unusable jj",
    (kind) =>
      Effect.gen(function* () {
        const { root, base } = yield* seedJjRepo({ prefix: "t3-jj-config-pin-", seed: true });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(root, ".t3code"));
        yield* fs.writeFileString(
          path.join(root, ".t3code", "vcs.json"),
          JSON.stringify({ vcs: { kind } }),
        );
        const realProcess = yield* VcsProcess.VcsProcess;
        const process: VcsProcess.VcsProcess["Service"] = {
          run: (input) =>
            realProcess.run({
              ...input,
              command: input.command === "jj" ? path.join(base, "missing-jj") : input.command,
            }),
        };
        yield* Effect.gen(function* () {
          const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
          const handle = yield* registry.resolve({ cwd: root });
          assert.equal(handle.kind, kind === "jj" ? "jj" : "git");
          if (kind === "unknown") assert.include(handle.notice, "PATH");
          else assert.isUndefined(handle.notice);
          if (kind === "unknown") {
            const requested = yield* registry.resolve({ cwd: root, requestedKind: "unknown" });
            assert.equal(requested.kind, "git");
            assert.include(requested.notice, "PATH");
          }
        }).pipe(
          Effect.provide(
            VcsDriverRegistry.layer.pipe(
              Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          VcsProcess.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );
  it.effect("falls back to Git with the error rather than a config migration warning", () =>
    Effect.gen(function* () {
      const { root, base } = yield* seedJjRepo({ prefix: "t3-jj-broken-config-", seed: true });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(root, ".jj", "repo", "config.toml"),
        "this is = = broken\n",
      );
      const realProcess = yield* VcsProcess.VcsProcess;
      let diagnostic = "";
      const process: VcsProcess.VcsProcess["Service"] = {
        run: (input) =>
          realProcess
            .run({
              ...input,
              env: { ...input.env, XDG_CONFIG_HOME: path.join(base, "config") },
            })
            .pipe(
              Effect.tap((output) =>
                Effect.sync(() => {
                  if (input.command === "jj") diagnostic = output.stderr;
                }),
              ),
            ),
      };
      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const handle = yield* registry.resolve({ cwd: root });
        assert.equal(handle.kind, "git");
        assert.include(diagnostic, "Config error:");
        assert.include(handle.notice, "Config error:");
        assert.notInclude(handle.notice, "Warning:");
        assert.notInclude(handle.notice, "Hint:");
        assert.notInclude(handle.notice, "\n");
        assert.isTrue(yield* handle.driver.isInsideWorkTree(root));
      }).pipe(
        Effect.provide(
          VcsDriverRegistry.layer.pipe(
            Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
            Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        VcsProcess.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
  it.effect.each(["missing", "old", "broken", "empty"] as const)(
    "selects usable colocated Git only for %s and recovers on rescan",
    (unavailable) =>
      Effect.gen(function* () {
        const { root, base } = yield* seedJjRepo({ prefix: "t3-jj-fallback-", seed: true });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const executable = path.join(base, "jj-test");
        if (unavailable !== "missing") {
          yield* fs.writeFileString(
            executable,
            unavailable === "old"
              ? "#!/bin/sh\nprintf 'jj 0.45.0\\n'\n"
              : unavailable === "empty"
                ? "#!/bin/sh\nexit 0\n"
                : "#!/bin/sh\nprintf 'broken config\\n' >&2\nexit 1\n",
          );
          yield* fs.chmod(executable, 0o755);
        }
        const realProcess = yield* VcsProcess.VcsProcess;
        let recovered = false;
        const process: VcsProcess.VcsProcess["Service"] = {
          run: (input) =>
            realProcess.run({
              ...input,
              command: input.command === "jj" && !recovered ? executable : input.command,
            }),
        };
        yield* Effect.gen(function* () {
          const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
          const pinned = yield* registry.resolve({ cwd: root, requestedKind: "git" });
          assert.equal(pinned.kind, "git");
          assert.isUndefined(pinned.notice);
          const handle = yield* registry.resolve({ cwd: root });
          assert.equal(handle.kind, "git");
          assert.isString(handle.notice);
          assert.include(handle.notice, "detached");
          assert.include(handle.notice, "commits won't be on a branch; push needs a branch");
          assert.equal(
            (yield* runGit(root, ["symbolic-ref", "-q", "HEAD"]).pipe(
              Effect.orElseSucceed(() => ""),
            )).trim(),
            "",
          );
          if (unavailable === "broken") assert.include(handle.notice, "broken config");
          if (unavailable === "empty") {
            assert.equal(
              handle.notice,
              "Jujutsu could not run: Jujutsu version probe returned an invalid version banner. Using Git for this colocated repository. Git HEAD may be detached: commits won't be on a branch; push needs a branch.",
            );
          }
          assert.isTrue(yield* handle.driver.isInsideWorkTree(root));
          const external = yield* seedJjRepo({ prefix: "t3-jj-noncolocated-", colocated: false });
          const noncolocated = yield* registry.resolve({ cwd: external.root });
          assert.equal(noncolocated.kind, "jj");
          assert.isUndefined(noncolocated.notice);
          const driver = yield* JjVcsDriver.JjVcsDriver;
          const unsupported = yield* Effect.result(driver.ensureUsable("test", external.root));
          assert.equal(unsupported._tag, "Failure");
          if (unsupported._tag === "Failure") {
            assert.equal(unsupported.failure._tag, "VcsUnsupportedOperationError");
            if (unsupported.failure._tag === "VcsUnsupportedOperationError") {
              assert.include(
                unsupported.failure.detail,
                "T3 Code supports colocated Jujutsu repositories.",
              );
            }
          }
          recovered = true;
          invalidateJjAvailability(process);
          assert.equal((yield* registry.resolve({ cwd: root })).kind, "jj");
        }).pipe(
          Effect.provide(
            VcsDriverRegistry.layer.pipe(
              Layer.provideMerge(
                JjVcsDriver.layer.pipe(
                  Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
                  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
                ),
              ),
              Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          VcsProcess.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );
  it.effect.each([false, true])(
    "caches unavailable-jj fallback with a canonical Git root (alias=%s)",
    (symlinkedGitRoot) =>
      Effect.gen(function* () {
        const { root, base } = yield* seedJjRepo({
          prefix: "t3-jj-fallback-boundary-",
          seed: true,
        });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const alias = path.join(base, "alias");
        yield* fs.symlink(root, alias);
        const realProcess = yield* VcsProcess.VcsProcess;
        let gitCalls = 0;
        const process: VcsProcess.VcsProcess["Service"] = {
          run: (input) =>
            Effect.gen(function* () {
              if (input.command === "git") gitCalls += 1;
              const output = yield* realProcess.run({
                ...input,
                command: input.command === "jj" ? path.join(base, "missing-jj") : input.command,
              });
              return symlinkedGitRoot &&
                input.command === "git" &&
                normalizeGitArgs(input.args).join(" ") === "rev-parse --show-toplevel"
                ? { ...output, stdout: `${alias}\n` }
                : output;
            }),
        };
        yield* Effect.gen(function* () {
          const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
          const first = yield* registry.resolve({ cwd: alias });
          assert.equal(first.kind, "git");
          assert.isString(first.notice);
          const initialCalls = gitCalls;
          assert.isAbove(initialCalls, 0);
          assert.equal((yield* registry.resolve({ cwd: alias })).kind, "git");
          assert.equal(gitCalls, initialCalls);
        }).pipe(
          Effect.provide(
            VcsDriverRegistry.layer.pipe(
              Layer.provideMerge(
                JjVcsDriver.layer.pipe(
                  Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
                  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
                ),
              ),
              Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          VcsProcess.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );
  it.effect(
    "refreshes registry review refs after the workflow driver invalidates remote caches",
    () =>
      Effect.gen(function* () {
        const { root } = yield* seedJjRepo({ prefix: "t3-jj-registry-cache-", withRemote: true });
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const workflowDriver = yield* JjVcsDriver.JjVcsDriver;
        const { driver } = yield* registry.resolve({ cwd: root });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(root, "review.txt"), "shared cache\n");
        if (driver.getDiffPreview === undefined) {
          assert.fail("The jj registry driver must expose review previews.");
        }

        const before = yield* driver.getDiffPreview({ cwd: root, baseRef: "origin/main" });
        const beforeBase = before.sources.find((source) => source.kind === "branch-range");
        assert.isString(beforeBase?.baseRef);
        assert.include(beforeBase?.diff ?? "", "+shared cache");
        assert.deepStrictEqual(yield* workflowDriver.listRemoteNames(root), ["origin"]);

        yield* runJj(root, ["git", "remote", "rename", "origin", "upstream"]);
        yield* workflowDriver.invalidateRepoCaches(root);

        const after = yield* driver.getDiffPreview({ cwd: root, baseRef: "upstream/main" });
        const afterBase = after.sources.find((source) => source.kind === "branch-range");
        assert.strictEqual(afterBase?.baseRef, beforeBase?.baseRef);
        assert.strictEqual(afterBase?.diff, beforeBase?.diff);
        assert.deepStrictEqual(yield* workflowDriver.listRemoteNames(root), ["upstream"]);
      }).pipe(
        Effect.provide(
          VcsDriverRegistry.layer.pipe(
            Layer.provideMerge(JjVcsDriver.layer),
            Layer.provide(VcsProcess.layer),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );
});

function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(`refs/t3/checkpoints/${Base64Url.encode(threadId)}/turn/${turnCount}`);
}

it.effect("keeps colocated jj markers on Git when repository selection requests Git", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const created = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-dormancy-" });
    const root = yield* fs.realPath(created);
    yield* fs.makeDirectory(path.join(root, ".jj", "repo"), { recursive: true });
    yield* fs.makeDirectory(path.join(root, ".git"), { recursive: true });
    yield* fs.makeDirectory(path.join(root, ".t3code"));
    yield* fs.writeFileString(path.join(root, ".t3code", "vcs.json"), '{"vcs":{"kind":"git"}}');
    const processLayer = Layer.mock(VcsProcess.VcsProcess)({
      run: (input) => {
        const args = input.args[0] === "-C" ? input.args.slice(2) : input.args;
        const command = args.join(" ");
        return Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout:
            command === "rev-parse --is-inside-work-tree --show-toplevel --git-common-dir"
              ? `true\n${root}\n${path.join(root, ".git")}\n`
              : command === "rev-parse --is-inside-work-tree"
                ? "true\n"
                : command === "rev-parse --show-toplevel"
                  ? `${root}\n`
                  : command === "rev-parse --git-common-dir"
                    ? `${path.join(root, ".git")}\n`
                    : `${input.command} version 1.0.0\n`,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    });
    const registryLayer = Layer.effect(
      VcsDriverRegistry.VcsDriverRegistry,
      VcsDriverRegistry.make,
    ).pipe(
      Layer.provide(JjVcsDriver.layer),
      Layer.provide(VcsProjectConfig.layer),
      Layer.provide(processLayer),
    );
    const discoveryLayer = SourceControlDiscovery.layer.pipe(
      Layer.provide(registryLayer),
      Layer.provide(ServerConfig.layerTest(root, { prefix: "t3-jj-dormancy-config-" })),
      Layer.provide(processLayer),
      Layer.provide(
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          discover: Effect.succeed([]),
          resolveLink: () => undefined,
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const detected = yield* registry.detect({ cwd: root });
      assert.strictEqual(detected?.kind, "git");
      assert.strictEqual(detected?.repository.rootPath, root);
      const jjDriver = yield* registry.get("jj").pipe(Effect.result);
      assert.strictEqual(jjDriver._tag, "Success");
      const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const result = yield* discovery.discover;
      const jj = result.versionControlSystems.find((item) => item.kind === "jj");
      assert.ok(jj);
      assert.strictEqual(jj.implemented, true);
    }).pipe(Effect.provide(Layer.merge(registryLayer, discoveryLayer)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("keeps Git checkpoints with an explicit Git selection and jj markers", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-config-dormancy-" });
    const processLayer = VcsProcess.layer.pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const registryLayer = VcsDriverRegistry.layer.pipe(Layer.provide(processLayer));
    const checkpointLayer = CheckpointStore.layer.pipe(Layer.provideMerge(registryLayer));
    yield* Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const git = (args: ReadonlyArray<string>) =>
        process.run({
          operation: "JjDormancy.test",
          command: "git",
          cwd: root,
          args,
        });
      yield* git(["init"]);
      yield* git(["config", "user.name", "Test"]);
      yield* git(["config", "user.email", "test@test.com"]);
      yield* fs.writeFileString(path.join(root, "file.txt"), "before\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "initial"]);
      yield* fs.makeDirectory(path.join(root, ".t3code"));
      yield* fs.writeFileString(path.join(root, ".t3code", "vcs.json"), '{"vcs":{"kind":"git"}}');
      yield* fs.makeDirectory(path.join(root, ".jj", "repo"), { recursive: true });
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      assert.strictEqual(
        (yield* registry.resolve({ cwd: root, requestedKind: "git" })).kind,
        "git",
      );
      assert.strictEqual((yield* registry.get("jj").pipe(Effect.result))._tag, "Success");
      const store = yield* CheckpointStore.CheckpointStore;
      assert.isTrue(yield* store.supportsCheckpoints(root));
      const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("dormant-jj-config"), 0);
      yield* fs.writeFileString(path.join(root, "file.txt"), "after\n");
      yield* store.captureCheckpoint({ cwd: root, checkpointRef });
      assert.isTrue(yield* store.hasCheckpointRef({ cwd: root, checkpointRef }));
      const captured = yield* git(["show", `${checkpointRef}:file.txt`]);
      assert.strictEqual(captured.stdout, "after\n");
    }).pipe(
      Effect.provide(
        Layer.merge(checkpointLayer, processLayer).pipe(
          Layer.provide(ServerConfig.layerTest(root, { prefix: "t3-jj-config-dormancy-home-" })),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

import { assert, describe, it } from "vite-plus/test";
import {
  GIT_VCS_TERMINOLOGY,
  JJ_VCS_TERMINOLOGY,
  resolveVcsTerminology,
  supportsVcsActions,
} from "./vcs.ts";

describe("VCS presentation and explicit capability", () => {
  it("keeps singleton terminology identities and permits unknown status", () => {
    assert.strictEqual(resolveVcsTerminology(null), GIT_VCS_TERMINOLOGY);
    assert.strictEqual(resolveVcsTerminology({ vcs: { kind: "jj" } }), JJ_VCS_TERMINOLOGY);
    assert.isTrue(supportsVcsActions(null));
    assert.isTrue(supportsVcsActions(undefined));
    assert.isTrue(supportsVcsActions({ vcs: { kind: "jj" } }));
    assert.isTrue(supportsVcsActions({ vcs: { kind: "git", notice: "Using Git." } }));
    assert.strictEqual(
      resolveVcsTerminology({ vcs: { kind: "git", notice: "Using Git." } }),
      GIT_VCS_TERMINOLOGY,
    );
    assert.isFalse(
      supportsVcsActions({ vcs: { kind: "jj", unsupportedReason: "Enable colocation." } }),
    );
  });
  it("keeps the English nouns server tool text uses", () => {
    assert.equal(GIT_VCS_TERMINOLOGY.repositoryAdjective, "git");
    assert.equal(GIT_VCS_TERMINOLOGY.workspaceNounPlural, "worktrees");
    assert.equal(JJ_VCS_TERMINOLOGY.repositoryAdjective, "Jujutsu");
    assert.equal(JJ_VCS_TERMINOLOGY.workspaceNoun, "workspace");
  });
});

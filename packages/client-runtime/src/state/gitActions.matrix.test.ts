import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildMenuItems, getGitActionDisabledReason, resolveQuickAction } from "./gitActions.ts";

const clean: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/test",
  hasWorkingTreeChanges: false,
  hasUpstream: true,
  aheadCount: 1,
  behindCount: 0,
  aheadOfDefaultCount: 1,
  pr: null,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};
const openPr = {
  number: 1,
  title: "Example",
  url: "https://github.com/a/b/pull/1",
  state: "open" as const,
  baseRef: "main",
  headRef: "feature/test",
};

type Case = {
  name: string;
  status: VcsStatusResult;
  remote?: boolean;
  busy?: boolean;
  mobile: readonly [readonly string[], string];
};
const cases: Case[] = [
  {
    name: "clean Git ahead",
    status: clean,
    mobile: [["push", "pr"], "create_pr"],
  },
  {
    name: "detached Git HEAD",
    status: { ...clean, refName: null },
    mobile: [[], "show_hint"],
  },
  {
    name: "dirty Git ahead",
    status: { ...clean, hasWorkingTreeChanges: true },
    mobile: [["commit", "pr"], "commit_push_pr"],
  },
  {
    name: "dirty jj ahead",
    status: { ...clean, vcs: { kind: "jj" }, hasWorkingTreeChanges: true },
    mobile: [["commit"], "commit_push_pr"],
  },
  {
    name: "clean jj ahead",
    status: { ...clean, vcs: { kind: "jj" } },
    mobile: [["push", "pr"], "create_pr"],
  },
  {
    name: "jj no bookmark",
    status: { ...clean, vcs: { kind: "jj" }, refName: null },
    mobile: [[], "show_hint"],
  },
  {
    name: "unsupported jj",
    status: { ...clean, vcs: { kind: "jj", unsupportedReason: "Unsupported workspace" } },
    mobile: [[], "show_hint"],
  },
  {
    name: "busy",
    status: clean,
    busy: true,
    mobile: [[], "show_hint"],
  },
  {
    name: "behind",
    status: { ...clean, aheadCount: 0, behindCount: 1 },
    mobile: [[], "run_pull"],
  },
  {
    name: "diverged jj",
    status: { ...clean, vcs: { kind: "jj" }, behindCount: 1 },
    mobile: [[], "show_hint"],
  },
  {
    name: "no remote",
    status: { ...clean, hasUpstream: false },
    remote: false,
    mobile: [[], "show_hint"],
  },
  {
    name: "open PR up to date",
    status: { ...clean, aheadCount: 0, pr: openPr },
    mobile: [["pr"], "open_pr"],
  },
  {
    name: "pushed feature",
    status: { ...clean, aheadCount: 0 },
    mobile: [["pr"], "create_pr"],
  },
];

describe("named mobile action policies", () => {
  it.each(cases)("$name", ({ status, remote = true, busy = false, mobile }) => {
    const menu = buildMenuItems(status, busy, remote);
    expect(menu.filter((item) => !item.disabled).map((item) => item.id)).toEqual(mobile[0]);
    const quick = resolveQuickAction(status, busy, false, remote);
    expect(quick.action ?? quick.kind).toBe(mobile[1]);
    if (status.vcs?.kind === "jj" && status.hasWorkingTreeChanges) {
      for (const id of ["push", "pr"] as const) {
        const item = menu.find((item) => item.id === id)!;
        expect(
          getGitActionDisabledReason({
            item,
            gitStatus: status,
            isBusy: busy,
            hasOriginRemote: remote,
          }),
        ).toBe("Commit local changes before pushing.");
      }
    }
  });

  it.each(["jj git colocation enable", "Could not read the Jujutsu workspace repository pointer."])(
    "disables unsupported jj actions with the server reason: %s",
    (reason) => {
      const status: VcsStatusResult = {
        ...clean,
        vcs: { kind: "jj", unsupportedReason: reason },
      };
      const items = buildMenuItems(status, false, true);
      expect(items.map((item) => item.id)).toEqual(["commit", "push", "pr"]);
      for (const item of items) {
        expect(item.disabled).toBe(true);
        expect(
          getGitActionDisabledReason({
            item,
            gitStatus: status,
            isBusy: false,
            hasOriginRemote: true,
          }),
        ).toBe(reason);
      }
      for (const hasOriginRemote of [false, true]) {
        const quickAction = resolveQuickAction(status, false, false, hasOriginRemote);
        expect(quickAction.disabled).toBe(true);
        expect(quickAction.kind).toBe("show_hint");
        expect(quickAction.hint).toBe(reason);
      }
    },
  );
});

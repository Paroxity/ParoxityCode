import { GIT_VCS_TERMINOLOGY, JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { act, render } from "../../test/render";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";

it.each([
  ["worktree", GIT_VCS_TERMINOLOGY],
  ["workspace", JJ_VCS_TERMINOLOGY],
] as const)(
  "blocks new and previous %s actions in an already-open picker without blocking local mode",
  async (workspaceNoun, terminology) => {
    const onEnvModeChange = vi.fn();
    const onUsePreviousWorktree = vi.fn();
    await using screen = await render(null);
    for (const supported of [true, false]) {
      await screen.rerender(
        <AppAtomRegistryProvider>
          <BranchToolbarEnvModeSelector
            envLocked={false}
            vcsActionsSupported={supported}
            effectiveEnvMode="worktree"
            activeWorktreePath={null}
            onEnvModeChange={onEnvModeChange}
            previousWorktreeLabel="Previous checkout"
            previousWorktreeBranch="previous"
            onUsePreviousWorktree={onUsePreviousWorktree}
            terminology={terminology}
          />
        </AppAtomRegistryProvider>,
      );
      if (supported) await userEvent.click(page.getByRole("combobox", { name: "Workspace" }));
    }
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    const create = options.find((option) => option.textContent?.includes(`New ${workspaceNoun}`));
    const previous = options.find((option) => option.textContent?.includes("previous"));
    expect(create?.getAttribute("aria-disabled")).toBe("true");
    expect(previous?.getAttribute("aria-disabled")).toBe("true");
    await act(() => {
      create?.click();
      previous?.click();
    });
    expect(onEnvModeChange).not.toHaveBeenCalled();
    expect(onUsePreviousWorktree).not.toHaveBeenCalled();
    const local = options.find((option) => option !== create && option !== previous)!;
    expect(local.getAttribute("aria-disabled")).not.toBe("true");
    await userEvent.click(local);
    expect(onEnvModeChange).toHaveBeenCalledExactlyOnceWith("local");
  },
);

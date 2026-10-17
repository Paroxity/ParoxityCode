import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { getVcsTerminology } from "@t3tools/shared/vcs";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { WorktreeSetupRows } from "./WorktreeSetupCard";

const NOW = new Date("2026-10-26T12:00:10.000Z");

function snapshot(overrides: Partial<WorktreeSetupSnapshot>): WorktreeSetupSnapshot {
  return {
    threadId: ThreadId.make("thread-1"),
    phase: "running",
    startedAt: "2026-10-26T12:00:00.000Z",
    endedAt: null,
    branch: "t3/feature",
    baseRef: "main",
    worktreePath: "/repo/.t3/worktrees/feature",
    setupScript: null,
    stages: [
      {
        id: "fetch",
        status: "done",
        startedAt: "2026-10-26T12:00:00.000Z",
        endedAt: "2026-10-26T12:00:03.000Z",
        percent: null,
        detail: null,
        tail: [],
      },
      {
        id: "checkout",
        status: "running",
        startedAt: "2026-10-26T12:00:03.000Z",
        endedAt: null,
        percent: null,
        detail: null,
        tail: [],
      },
    ],
    error: null,
    sequence: 1,
    ...overrides,
  };
}

const rows = (value: WorktreeSetupSnapshot, kind: "git" | "jj" = "git") => (
  <WorktreeSetupRows snapshot={value} terminology={getVcsTerminology(kind)} onOpenTerminal={null} />
);

it("ticks the running stage duration", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  await using screen = await render(rows(snapshot({})));
  // Assert synchronously: expect.element polls on timers these tests fake.
  const checkout = screen
    .getByRole("region", { name: "Worktree setup" })
    .element()
    .querySelector('[data-worktree-setup-stage="checkout"]');

  expect(checkout?.textContent).toContain("Checking out t3/feature");
  expect(checkout?.textContent).toContain("7s");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(checkout?.textContent).toContain("12s");
});

it("keeps the finished setup duration at its end", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  const done = snapshot({
    phase: "done",
    endedAt: "2026-10-26T12:00:05.000Z",
    stages: snapshot({}).stages.map((stage) => ({
      ...stage,
      status: "done",
      endedAt: stage.endedAt ?? "2026-10-26T12:00:05.000Z",
    })),
  });
  await using screen = await render(rows(done));
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("Set up worktree t3/feature5s");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("Set up worktree t3/feature5s");
});

function finished(phase: WorktreeSetupSnapshot["phase"]): WorktreeSetupSnapshot {
  return snapshot({
    phase,
    endedAt: phase === "running" ? null : "2026-10-26T12:00:05.000Z",
    stages: [],
  });
}

describe("WorktreeSetupRows terminology", () => {
  it.each([
    ["git", "Worktree", "Set up worktree t3/feature"],
    ["jj", "Workspace", "Set up workspace t3/feature"],
  ] as const)(
    "uses %s labels for completed and interrupted setup",
    async (kind, title, summary) => {
      for (const phase of ["done", "failed", "cancelled"] as const) {
        await using screen = await render(rows(finished(phase), kind));
        const { container } = screen;
        expect(container.querySelector(`[aria-label="${title} setup"]`)).not.toBeNull();
        if (phase === "done") expect(container.textContent).toContain(summary);
      }
    },
  );

  it.each([
    ["git", "Fetched base branch"],
    ["jj", "Fetched base bookmark"],
  ] as const)("names the %s base ref when the fetch has no ref name", async (kind, label) => {
    const failedSetup = snapshot({ phase: "failed", endedAt: "2026-10-26T12:00:05.000Z" });
    await using screen = await render(rows({ ...failedSetup, baseRef: null }, kind));
    expect(
      screen.container.querySelector('[data-worktree-setup-stage="fetch"]')?.textContent,
    ).toContain(label);
  });

  it("keeps setup script failure visible in Jujutsu summaries", async () => {
    const failedSetup = finished("done");
    await using screen = await render(
      rows(
        {
          ...failedSetup,
          stages: [
            {
              id: "setup-script",
              status: "failed",
              startedAt: failedSetup.startedAt,
              endedAt: failedSetup.endedAt,
              percent: null,
              detail: null,
              tail: [],
            },
          ],
        },
        "jj",
      ),
    );
    const { container } = screen;
    expect(container.querySelector('[aria-label="Workspace setup"]')).not.toBeNull();
    expect(
      container.querySelector(
        '[data-worktree-setup-stage="setup-script"][data-worktree-setup-status="failed"]',
      )?.textContent,
    ).toContain("Failed setup script");
  });
});

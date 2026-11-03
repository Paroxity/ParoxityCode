import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import type { PullRequestDiffParams } from "./usePullRequestDiff";

/** Names the diff a screen shows, for its title and for keys that must not mix two diffs. */
export function pullRequestDiffScope(params: PullRequestDiffParams, resolve: MessageResolver = m) {
  const { commit, round } = params;
  if (commit) return { key: commit, title: resolve(msg("Commit changes")) };
  if (round?.since !== undefined)
    return {
      key: `since:${round.since}:${round.number}`,
      title: resolve(msg("Changes since round {number}", { number: round.since })),
    };
  if (round)
    return {
      key: `round:${round.number}`,
      title: resolve(msg("Round {number} changes", { number: round.number })),
    };
  return { key: "all", title: resolve(msg("Changes")) };
}

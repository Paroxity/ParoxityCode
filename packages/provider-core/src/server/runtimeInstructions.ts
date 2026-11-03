// @effect-diagnostics nodeBuiltinImport:off -- A few synchronous stats while building turn text; adapters build it outside any FileSystem service.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { AgentFeedbackMode } from "@t3tools/contracts";

import type { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";

/** None while agent feedback is off, so users who never opt in pay no context for it. */
export const AGENT_FEEDBACK_INSTRUCTIONS = {
  off: "",
  "on-request": "Use `t3_feedback` only when the user asks you to send T3 feedback.",
  auto: "`t3_feedback` reports are wanted and cheap. Send one, then continue, when a T3 tool or `t3` command fails or gives a wrong result, the user corrects how you use T3 Code, or a T3 capability you looked for is missing. Once per problem; also when the user asks. Only about T3 Code, never the user's code or other tools.",
} satisfies Record<AgentFeedbackMode, string>;

/** Session-invariant; harnesses with a native system-prompt append can carry it once per session. */
export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: link_pull_request, or link_pull_requests for several, full URL, every stack layer, as your next call. Host tools don't link for you. If linking fails, say so. Skip PRs you only read or review and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch. When pull_request_* tools are listed, use them, not gh or cafe, to read, list, open, edit, review, reply on, close, or merge PRs, and ci_logs and ci_rerun for their checks. pull_request_create links for you.
If available, call link_issue for each issue you take on or file, even via CLI; skip issues you only read.
</pull_request_linking>`;

const JJ_INSTRUCTIONS = `<version_control>
This is a colocated Jujutsu (jj) repository, despite the .git directory. Use jj, not git, for anything that writes: commit, describe, new, bookmarks, push, and restoring files. git restore, git clean, git commit and git checkout bypass jj's working copy. Read with jj too: git's HEAD is not the working-copy change @, so use jj status, jj diff and jj log.
</version_control>`;

/**
 * Mirrors the server's jj detection (apps/server/src/vcs/JjRepo.ts): the nearest `.jj` or `.git`
 * above cwd wins, and the nearest `.t3code/vcs.json` Git pin opts out. jj availability is not checked.
 */
function isJjWorkspace(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  let current: string;
  try {
    current = NodeFS.realpathSync(cwd);
  } catch {
    return false;
  }
  let marker: "jj" | "git" | null = null;
  let pinned: string | null = null;
  for (;;) {
    pinned ??= readVcsPin(current);
    if (marker === null) {
      if (isDirectory(NodePath.join(current, ".jj"))) marker = "jj";
      else if (NodeFS.existsSync(NodePath.join(current, ".git"))) marker = "git";
    }
    if (marker !== null && pinned !== null) break;
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return marker === "jj" && pinned !== "git";
}

function isDirectory(path: string): boolean {
  try {
    return NodeFS.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The nearest pin file decides even when it says "auto"; unreadable files count as auto. */
function readVcsPin(dir: string): string | null {
  const file = NodePath.join(dir, ".t3code", "vcs.json");
  if (!NodeFS.existsSync(file)) return null;
  try {
    const config = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
      vcs?: { kind?: unknown };
      vcsKind?: unknown;
    };
    const kind = config.vcs?.kind ?? config.vcsKind;
    return typeof kind === "string" ? kind : "auto";
  } catch {
    return "auto";
  }
}

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly agentFeedback?: AgentFeedbackMode;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** False when the session's system prompt already carries the linking instructions. */
  readonly pullRequestLinking?: boolean;
  /** Adds the folder list of a multi-folder thread. */
  readonly runtimePolicy?: Pick<ProviderAdapterV2RuntimePolicy, "cwd" | "workspace"> | undefined;
  /** The agent's working directory when no runtime policy names it; a jj workspace adds jj guidance. */
  readonly cwd?: string | null | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio using Markdown image syntax with absolute file paths. Link every other file you cite or produce by its absolute path, as in [http.ts:42](/abs/path/http.ts:42), so the user can open it in T3 Code's files viewer.</runtime_info>`;
  const feedbackLine = AGENT_FEEDBACK_INSTRUCTIONS[runtime.agentFeedback ?? "off"];
  const feedback = feedbackLine ? `\n${feedbackLine}` : "";
  const workspace =
    runtime.runtimePolicy === undefined ? "" : buildWorkspaceInstructions(runtime.runtimePolicy);
  const linked =
    runtime.pullRequestLinking === false
      ? runtimeInfo
      : `${runtimeInfo}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
  const jj = isJjWorkspace(runtime.cwd ?? runtime.runtimePolicy?.cwd) ? JJ_INSTRUCTIONS : "";
  return [linked + feedback, ...[workspace, jj].filter((part) => part !== "")].join("\n\n");
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

// Codex truncates context entries over 4,000 bytes, and this block is sent as its own entry.
const WORKSPACE_INSTRUCTIONS_MAX_BYTES = 3_600;
const FOLDER_NAME_MAX_LENGTH = 64;
// Control characters and Unicode line separators would let a name or path add lines.
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const textEncoder = new TextEncoder();

const byteLength = (value: string) => textEncoder.encode(value).length;

/** Names come from users and disk; keep each one a short label that cannot close the block. */
function folderLabel(name: string): string {
  const label = Array.from(
    name.replaceAll(LINE_BREAKING, " ").replaceAll(/[<>`]/g, " ").replaceAll(/\s+/g, " ").trim(),
  );
  if (label.length === 0) return "folder";
  return label.length > FOLDER_NAME_MAX_LENGTH
    ? `${label.slice(0, FOLDER_NAME_MAX_LENGTH - 1).join("")}…`
    : label.join("");
}

const folderPath = (value: string) =>
  value.replaceAll(LINE_BREAKING, "?").replaceAll("<", "‹").replaceAll(">", "›");

/** Lists a multi-folder thread's folders. Empty for single-folder threads, so their text is unchanged. */
export function buildWorkspaceInstructions(
  runtimePolicy: Pick<ProviderAdapterV2RuntimePolicy, "cwd" | "workspace">,
): string {
  const workspace = runtimePolicy.workspace;
  if (workspace === undefined || workspace.folders.length === 0) return "";
  const head = [
    "<workspace_folders>",
    "This project spans several folders. Each Git repository has its own history and branches: run Git commands inside the repository you change, and commit each one separately.",
    ...(runtimePolicy.cwd === null
      ? []
      : [`- Your working directory: ${folderPath(runtimePolicy.cwd)}`]),
  ];
  const tail = ["</workspace_folders>"];
  const entries = workspace.folders.map(
    (folder) =>
      `- ${folderLabel(folder.name)} (${folder.isGitRepository ? "Git repository" : "folder"}): ${folderPath(folder.path)}`,
  );
  // Reserve room for the line that counts folders left out.
  let budget = WORKSPACE_INSTRUCTIONS_MAX_BYTES - byteLength([...head, ...tail].join("\n")) - 32;
  const shown: Array<string> = [];
  for (const entry of entries) {
    budget -= byteLength(entry) + 1;
    if (budget < 0) break;
    shown.push(entry);
  }
  const hidden = entries.length - shown.length;
  return [...head, ...shown, ...(hidden > 0 ? [`- Not listed: ${hidden} more`] : []), ...tail].join(
    "\n",
  );
}

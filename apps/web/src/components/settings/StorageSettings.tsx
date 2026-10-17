import type {
  StorageCleanupReport,
  StorageCleanupSettings,
  VcsStatusResult,
  WorktreeCleanupRules,
} from "@t3tools/contracts";
import { resolvePastedPath } from "@t3tools/shared/path";
import { getVcsTerminology } from "@t3tools/shared/vcs";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { CalendarIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { formatBytes } from "../../lib/formatBytes";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { useEnvironmentQuerySelector } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useDebouncedValue } from "../../state/queries";
import { AnimatedHeight } from "../AnimatedHeight";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";

import { Input } from "../ui/input";
import { InputGroup, InputGroupInput, InputGroupUnit } from "../ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { DatabaseStorageNotice } from "./DatabaseStorageNotice";
import { AdvancedSettings } from "./AdvancedSettings";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsGroup } from "./SettingsGroup";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  useClearScopedSettings,
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
const selectStorageVcsKind = (status: AsyncResult.AsyncResult<VcsStatusResult, unknown>) =>
  Option.getOrNull(AsyncResult.value(status))?.vcs?.kind;

function useStorageVcsKind() {
  const { scope, target } = useSettingsScope();
  const checkout =
    scope.kind === "checkout"
      ? scope.checkout
      : scope.kind === "project" && scope.members.length === 1
        ? scope.members.find((member) => member.id === target?.projectId)
        : null;
  const environmentId = checkout?.environmentId;
  const cwd = checkout?.workspaceRoot;
  return useEnvironmentQuerySelector(
    environmentId == null || cwd == null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd, includeRemote: false } }),
    selectStorageVcsKind,
  );
}

export function WorktreesDirectoryRow() {
  const setting = useSearchableSetting();
  const gt = useGT();
  const { connectedEnvironments, targets } = useSettingsScope();
  const terminology = getVcsTerminology(useStorageVcsKind());
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreesDirectory"]);
  const edited = useRef(false);
  const draft = useRef("");
  if (
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.worktreesDirectory !== true,
    )
  )
    return null;
  const scopeKey = targets.map((target) => target.environmentId).join(",");
  const location = setting("storage-worktrees-location");

  return (
    <SettingsRow
      {...location}
      title={terminology.kind === "jj" ? gt("Workspace location") : location.title}
      description={
        terminology.kind === "jj"
          ? gt(
              "Folder where new workspaces are created, on any drive, such as D:\\workspaces or ~/workspaces. Existing workspaces stay where they are. Leave empty to use the T3 home folder.",
            )
          : gt(
              "Folder where new worktrees are created, on any drive, such as D:\\worktrees or ~/worktrees. Existing worktrees stay where they are. Leave empty to use the T3 home folder.",
            )
      }
      serverScoped
      settingKeys={["worktreesDirectory"]}
      resetAction={
        mixed || settings.worktreesDirectory !== "" ? (
          <SettingResetButton
            ariaLabel={
              terminology.kind === "jj"
                ? gt("Reset workspace location to default")
                : gt("Reset worktree location to default")
            }
            onClick={() => updateSettings({ worktreesDirectory: "" })}
          />
        ) : null
      }
      control={
        <Input
          size="settings"
          key={`${scopeKey}:${mixed}:${settings.worktreesDirectory}`}
          aria-label={
            terminology.kind === "jj" ? gt("Workspace location") : gt("Worktree location")
          }
          autoCapitalize="none"
          spellCheck={false}
          placeholder={mixed ? gt("Mixed") : gt("Default")}
          defaultValue={mixed ? "" : settings.worktreesDirectory}
          onFocus={(event) => {
            draft.current = event.target.value;
          }}
          onChange={(event) => {
            edited.current = true;
            draft.current = resolvePastedPath(draft.current, event.target.value);
            event.target.value = draft.current;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.worktreesDirectory))
              updateSettings({ worktreesDirectory: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}

type SaveOptions = Parameters<ReturnType<typeof useUpdateScopedSettings>>[1];

const RETENTION_PRESET_DAYS = [1, 3, 7, 14, 30, 60, 90, 180, 365] as const;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
// Opening a custom draft must not enable cleanup before its first save.
const DEFAULT_RETENTION_DAYS = 8;

function formatRetentionDays(days: number, resolve: MessageResolver = m): string {
  return resolve(msg("{days, plural, one {After {days} day} other {After {days} days}}", { days }));
}

/**
 * A retention duration: Off, a preset, or Custom with a days field for any
 * value in range. A stored value that is not a preset opens as Custom.
 */
function RetentionControl({
  label,
  value,
  onChange,
  minimum = MIN_RETENTION_DAYS,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null, onFailed: () => void) => void;
  minimum?: number;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [customRequested, setCustomRequested] = useState(false);
  const [draft, setDraft] = useState(String(value ?? DEFAULT_RETENTION_DAYS));
  const [savedValue, setSavedValue] = useState(value);
  const edited = useRef(false);
  const menuOpen = useRef(false);
  const pending = useRef<{ days: number | null } | null>(null);
  const [submitted, setSubmitted] = useState<{ days: number | null } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const row = useRef<HTMLDivElement>(null);
  if (savedValue !== value) {
    setSavedValue(value);
    setSubmitted(null);
    setDraft(String(value ?? DEFAULT_RETENTION_DAYS));
  }
  const currentValue = submitted ? submitted.days : value;
  const isPreset =
    currentValue !== null && (RETENTION_PRESET_DAYS as readonly number[]).includes(currentValue);
  const custom = customRequested || (currentValue !== null && !isPreset);
  const selected = custom ? "custom" : currentValue === null ? "off" : String(currentValue);
  const save = (days: number | null) => {
    edited.current = false;
    const submission = { days };
    pending.current = submission;
    setSubmitted(submission);
    onChange(days, () => {
      if (pending.current !== submission) return;
      pending.current = null;
      setSubmitted(null);
      setDraft(String(value ?? DEFAULT_RETENTION_DAYS));
      if (value === null) setCustomRequested(false);
    });
  };
  const commit = () => {
    const parsed = Number(draft);
    edited.current = false;
    if (
      draft.trim() !== "" &&
      Number.isInteger(parsed) &&
      parsed >= minimum &&
      parsed <= MAX_RETENTION_DAYS
    ) {
      setDraft(String(parsed));
      if (parsed !== currentValue) save(parsed);
    } else setDraft(String(currentValue ?? DEFAULT_RETENTION_DAYS));
  };
  return (
    <div
      ref={row}
      className="flex items-center gap-2"
      onBlur={(event) => {
        if (menuOpen.current || event.currentTarget.contains(event.relatedTarget)) return;
        if (edited.current) commit();
        else if (value === null && pending.current === null) setCustomRequested(false);
      }}
    >
      <Select
        value={selected}
        onOpenChange={(open) => {
          menuOpen.current = open;
        }}
        onValueChange={(next) => {
          edited.current = false;
          if (next === "off") {
            setCustomRequested(false);
            if (currentValue !== null) save(null);
          } else if (next === "custom") {
            setCustomRequested(true);
            setDraft(String(value ?? DEFAULT_RETENTION_DAYS));
          } else if (next !== null) {
            setCustomRequested(false);
            save(Number(next));
          }
        }}
      >
        <SelectTrigger
          variant="well"
          size="compact"
          aria-label={label}
          leadingIcon={<CalendarIcon />}
          className="w-auto min-w-36"
        >
          <SelectValue>
            {selected === "off"
              ? gt("Off")
              : selected === "custom"
                ? gt("Custom")
                : formatRetentionDays(Number(selected), messages)}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup
          align="end"
          alignItemWithTrigger={false}
          finalFocus={custom ? input : undefined}
        >
          <SelectItem value="off">
            <T>Off</T>
          </SelectItem>
          {RETENTION_PRESET_DAYS.map((days) => (
            <SelectItem key={days} value={String(days)}>
              {formatRetentionDays(days, messages)}
            </SelectItem>
          ))}
          <SelectItem value="custom">
            <T>Custom</T>
          </SelectItem>
        </SelectPopup>
      </Select>
      {custom ? (
        <InputGroup className="w-24">
          <InputGroupInput
            ref={input}
            autoFocus
            size="settings"
            type="number"
            min={minimum}
            max={MAX_RETENTION_DAYS}
            value={draft}
            aria-label={gt("{label} in days", { label })}
            onChange={(event) => {
              edited.current = true;
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter") {
                commit();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                edited.current = false;
                setDraft(String(value ?? DEFAULT_RETENTION_DAYS));
                if (value === null) setCustomRequested(false);
              }
            }}
          />
          <InputGroupUnit>days</InputGroupUnit>
        </InputGroup>
      ) : null}
    </div>
  );
}

const KEEP_WHEN_LABELS = {
  "any-local-files": msg("Any local files"),
  "uncommitted-changes": msg("Uncommitted changes"),
  "tracked-changes": msg("Edited tracked files"),
} as const;

function lastRunSummary(
  entries: readonly { readonly label: string; readonly counts: string }[],
  machineCount: number,
  resolve: MessageResolver = m,
) {
  const first = entries[0];
  if (!first) return "";
  if (machineCount <= 1) return first.counts;
  if (entries.length === machineCount && entries.every((entry) => entry.counts === first.counts)) {
    return resolve(msg("{counts} on every machine", { counts: first.counts }));
  }
  return (
    <span className="grid gap-1">
      {entries.map((entry) => (
        <span key={entry.label}>
          {entry.label}: {entry.counts}
        </span>
      ))}
    </span>
  );
}

function CleanupResults({
  report,
  environmentLabel,
}: {
  report: StorageCleanupReport;
  environmentLabel: string;
}) {
  const gt = useGT();
  const terminology = getVcsTerminology(useStorageVcsKind());
  return (
    <>
      {report.entries.map((entry, index) => {
        const name =
          entry.kind === "worktree"
            ? ((entry.threadId === null
                ? entry.path
                : entry.path?.split(/[\\/]/).findLast(Boolean)) ??
              (terminology.kind === "jj" ? gt("Workspaces") : gt("Worktrees")))
            : entry.kind === "logs"
              ? gt("Rotated logs")
              : gt("Browser artifacts");
        return (
          <SettingsRow
            key={`${entry.path ?? entry.kind}:${entry.threadId ?? index}`}
            title={<span className="wrap-anywhere select-text">{name}</span>}
            description={
              <span className="block space-y-2 wrap-anywhere select-text">
                <span className={`block ${entry.outcome === "failed" ? "text-destructive" : ""}`}>
                  {entry.reason}
                </span>
                <span className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-l border-border/60 pl-3">
                  <span>
                    <T>Machine</T>
                  </span>
                  <span className="text-foreground/80">{environmentLabel}</span>
                  {entry.projectPath && (
                    <>
                      <span>
                        <T>Project</T>
                      </span>
                      <code className="text-foreground/80">{entry.projectPath}</code>
                    </>
                  )}
                  {entry.path && (
                    <>
                      <span>
                        <T>Folder</T>
                      </span>
                      <code className="text-foreground/80">{entry.path}</code>
                    </>
                  )}
                  {entry.threadTitle && (
                    <>
                      <span>
                        <T>Thread</T>
                      </span>
                      <span>{entry.threadTitle}</span>
                    </>
                  )}
                </span>
              </span>
            }
            control={
              (entry.outcome === "removed" ||
                (entry.outcome === "kept" && entry.bytes !== null)) && (
                <span className="grid justify-items-end gap-1 text-meta text-muted-foreground">
                  {entry.kind !== "worktree" && entry.files !== null ? (
                    <span>
                      {gt("{count, plural, one {{formatted} file} other {{formatted} files}}", {
                        count: entry.files,
                        formatted: entry.files.toLocaleString(),
                      })}
                    </span>
                  ) : null}
                  {entry.bytes !== null ? <span>{formatBytes(entry.bytes)}</span> : null}
                </span>
              )
            }
          />
        );
      })}
      {report.omittedCount > 0 && (
        <p className="px-3 py-2.5 text-meta text-muted-foreground sm:px-4">
          {gt(
            "{omitted, plural, one {{environment}: {count} more results.} other {{environment}: {count} more results.}}",
            {
              omitted: report.omittedCount,
              environment: environmentLabel,
              count: report.omittedCount.toLocaleString(),
            },
          )}
        </p>
      )}
      {report.entries.length === 0 && report.omittedCount === 0 && (
        <p className="px-3 py-2.5 text-meta text-muted-foreground sm:px-4">
          <T>
            <Var>{environmentLabel}</Var>: Nothing needed cleanup.
          </T>
        </p>
      )}
    </>
  );
}

const storageCleanupReportsAtom = environmentAtomList(
  "web-storage-cleanup-reports",
  (environmentId) => serverEnvironment.storageCleanupReport({ environmentId, input: {} }),
);
const storageCleanupPermissionsAtom = environmentAtomList(
  "web-storage-cleanup-permissions",
  serverEnvironment.runStorageCleanup.permissionAtom,
);

function CleanupSection() {
  const messages = useMessages();
  const setting = useSearchableSetting();
  const gt = useGT();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const { connectedEnvironments } = useSettingsScope();
  const [pending, setPending] = useState(false);
  const run = useAtomCommand(serverEnvironment.runStorageCleanup);
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.storageCleanupRun === true,
  );
  const supportedIds = supported.map(({ environmentId }) => environmentId);
  const reports = useAtomValue(storageCleanupReportsAtom(environmentIdsKey(supportedIds)));
  const permissions = useAtomValue(storageCleanupPermissionsAtom(environmentIdsKey(supportedIds)));
  const state = supportedIds.map((environmentId, index) => {
    const query = reports[index]!;
    return {
      environmentId,
      allowed: permissions[index]!,
      report: query._tag === "Success" ? query.value : null,
      loading: query.waiting,
      failed: query._tag === "Failure",
    };
  });
  const hasRules = supported.some((environment) => {
    const settings = environment.serverConfig?.settings;
    if (!settings) return false;
    const enabled = (rules: WorktreeCleanupRules) =>
      rules.worktreeAfterDays !== null ||
      rules.worktreeSettledAfterDays !== null ||
      rules.worktreeOnMerge ||
      rules.worktreeOnDelete ||
      rules.worktreeUnchanged;
    return (
      settings.storageCleanup.browserArtifactsAfterDays !== null ||
      settings.storageCleanup.logsAfterDays !== null ||
      enabled(resolveWorktreeCleanup(settings, null)) ||
      Object.values(settings.projectSettingsOverrides).some(
        (override) =>
          override.worktreeCleanup?.mode === "custom" && enabled(override.worktreeCleanup.rules),
      )
    );
  });
  if (supported.length === 0) return null;
  const summaries = supported.map((environment) => {
    const query = state.find((entry) => entry.environmentId === environment.environmentId);
    const report = query?.report ?? null;
    return {
      environment,
      report,
      label: settingsScopeEnvironmentLabels(environment, connectedEnvironments).primary,
      secondary: settingsScopeEnvironmentLabels(environment, connectedEnvironments).secondary,
      counts: report
        ? report.counts.failed > 0
          ? gt("{removed} removed, {kept} kept, {failed} failed", report.counts)
          : gt("{removed} removed, {kept} kept", report.counts)
        : "",
      description: report
        ? report.counts.failed > 0
          ? gt(
              "{count, plural, one {Last run {when}. {bytes} recovered. {count} item couldn't be removed.} other {Last run {when}. {bytes} recovered. {count} items couldn't be removed.}}",
              {
                count: report.counts.failed,
                when: formatRelativeTimeLabel(report.finishedAt, nowMs, messages),
                bytes: formatBytes(report.bytesFreed),
              },
            )
          : gt("Last run {when}. {bytes} recovered.", {
              when: formatRelativeTimeLabel(report.finishedAt, nowMs, messages),
              bytes: formatBytes(report.bytesFreed),
            })
        : query?.failed
          ? gt("Could not load the last run.")
          : query?.loading
            ? gt("Loading last run…")
            : gt("Cleanup hasn't run yet."),
    };
  });
  const deleteNow = async () => {
    if (pending) return;
    setPending(true);
    await Promise.all(
      supported
        .filter((environment) =>
          state.some((entry) => entry.environmentId === environment.environmentId && entry.allowed),
        )
        .map(async (environment) => {
          const result = await run({ environmentId: environment.environmentId, input: {} });
          if (result._tag === "Success") {
            const failures = result.value.entries.filter((entry) => entry.outcome === "failed");
            if (failures.length > 0)
              toastManager.add({
                type: "error",
                title: gt("Cleanup failed on {label}", { label: environment.label }),
                description: failures[0]!.reason,
              });
          } else if (!isAtomCommandInterrupted(result)) {
            toastManager.add({
              type: "error",
              title: gt("Could not run cleanup on {label}", { label: environment.label }),
              description: String(squashAtomCommandFailure(result)),
            });
          }
        }),
    ).finally(() => setPending(false));
  };
  return (
    <SettingsSection id="storage-cleanup" title={gt("Cleanup")} variant="plain">
      <SettingsGroup>
        <SettingsRow
          {...setting("storage-delete-now")}
          description={
            <span>
              {!hasRules
                ? gt("Turn on a cleanup rule to use this.")
                : summaries.map(({ environment, label, secondary, description }) => (
                    <span key={environment.environmentId} className="block">
                      {supported.length > 1 ? (
                        <span className="block">
                          {label}
                          {secondary ? <span className="block">{secondary}</span> : null}
                        </span>
                      ) : null}
                      {description}
                    </span>
                  ))}
            </span>
          }
          control={
            <Button
              variant="secondary"
              size="sm"
              disabled={pending || !hasRules || !state.some((entry) => entry.allowed)}
              onClick={() => void deleteNow()}
            >
              {pending ? gt("Deleting…") : gt("Delete now")}
            </Button>
          }
        />
      </SettingsGroup>
      {summaries.some(({ report }) => report !== null) && (
        <FoldedSettingsSection
          id="storage-cleanup-last-run"
          title={gt("Last run")}
          headerPlacement="inside"
          summary={lastRunSummary(
            summaries.filter(({ report }) => report !== null),
            connectedEnvironments.length,
            messages,
          )}
        >
          {summaries.map(
            ({ environment, label, report }) =>
              report && (
                <CleanupResults
                  key={environment.environmentId}
                  report={report}
                  environmentLabel={label}
                />
              ),
          )}
        </FoldedSettingsSection>
      )}
    </SettingsSection>
  );
}

function supportsStorageCleanup(
  environments: ReadonlyArray<{
    readonly serverConfig: {
      readonly environment: { readonly capabilities: { readonly storageCleanup?: boolean } };
    } | null;
  }>,
) {
  return environments.every(
    (environment) => environment.serverConfig?.environment.capabilities.storageCleanup === true,
  );
}

/** Narrows a mixed selection to the machines that support cleanup. */
function StorageCleanupScopeNotice() {
  const gt = useGT();
  const { connectedEnvironments } = useSettingsScope();
  return (
    <SettingsScopeNotice
      inline
      target="environment"
      eligibleEnvironmentIds={connectedEnvironments
        .filter(
          (environment) =>
            environment.serverConfig?.environment.capabilities.storageCleanup === true,
        )
        .map((environment) => environment.environmentId)}
    >
      {gt(
        "Update the selected environments to use storage cleanup, or choose a machine that supports it.",
      )}
    </SettingsScopeNotice>
  );
}

export function WorktreeCleanupSection({ title }: { title?: string }) {
  const messages = useMessages();
  const setting = useSearchableSetting();
  const gt = useGT();
  const sectionTitle = title ?? gt("Cleanup");
  const { scope, environments, connectedEnvironments, targets, target } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const vcsKind = useStorageVcsKind();
  const terminology = getVcsTerminology(vcsKind);
  const settings = {
    ...scopedSettings.storageCleanup,
    ...resolveWorktreeCleanup(scopedSettings, null),
  };
  const projectMode = (entry: ScopedSettingsTarget | null) =>
    entry?.sources.worktreeCleanup === "project"
      ? (entry.settings.worktreeCleanup?.mode ?? "inherit")
      : "inherit";
  const mode = projectMode(target);
  const mixedModes = targets.some((entry) => projectMode(entry) !== mode);
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const ruleStatus = (key: keyof StorageCleanupSettings) =>
    targets.some(
      (target) =>
        ({ ...target.settings.storageCleanup, ...resolveWorktreeCleanup(target.settings, null) })[
          key
        ] !== settings[key],
    )
      ? gt("Mixed across selected machines")
      : undefined;
  // A policy locks these through worktreeCleanup, which also reaches each project's own rules.
  const lockablePath = (key: keyof WorktreeCleanupRules) =>
    isProjectScope ? ["worktreeCleanup"] : ["worktreeCleanup", `storageCleanup.${key}`];
  const update = (patch: Partial<StorageCleanupSettings>, options?: SaveOptions) =>
    updateSettings({ storageCleanup: patch }, options);
  const updateWorktree = (patch: Partial<WorktreeCleanupRules>, options?: SaveOptions) =>
    isProjectScope
      ? updateSettings({ worktreeCleanup: { mode: "custom", rules: patch } }, options)
      : update(patch, options);

  if (
    isProjectScope &&
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.projectWorktreeCleanup !== true,
    )
  ) {
    return (
      <SettingsSection id="storage-worktrees" title={sectionTitle} variant="plain">
        <SettingsScopeNotice inline target="all">
          {terminology.kind === "jj"
            ? gt("Update the selected machines to configure project workspace cleanup.")
            : gt("Update the selected machines to configure project worktree cleanup.")}
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  if (!supportsStorageCleanup(connectedEnvironments)) {
    return (
      <SettingsSection id="storage-worktrees" title={sectionTitle} variant="plain">
        <StorageCleanupScopeNotice />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection id="storage-worktrees" title={sectionTitle}>
      <>
        {isProjectScope && (
          <SettingsRow
            title={
              terminology.kind === "jj"
                ? gt("Automatic workspace cleanup")
                : gt("Automatic worktree cleanup")
            }
            description={
              terminology.kind === "jj"
                ? mode === "off"
                  ? gt("Keep this project's workspaces until you delete them manually.")
                  : mode === "custom"
                    ? gt(
                        "Use these rules for this project. Changes and unbookmarked commits are kept.",
                      )
                    : gt(
                        "Use each machine's workspace cleanup settings. Changes and unbookmarked commits are kept.",
                      )
                : mode === "off"
                  ? gt("Keep this project's worktrees until you delete them manually.")
                  : mode === "custom"
                    ? gt("Use these rules for this project.")
                    : gt("Use each machine's worktree cleanup settings.")
            }
            serverScoped
            settingKeys={["worktreeCleanup"]}
            mixed={mixedModes}
            control={
              <ToggleGroup
                aria-label={
                  terminology.kind === "jj"
                    ? gt("Automatic workspace cleanup")
                    : gt("Automatic worktree cleanup")
                }
                value={mixedModes ? [] : [mode]}
                onValueChange={(values) => {
                  const next = values[0];
                  if (next === "inherit") clearSettings(["worktreeCleanup"]);
                  else if (next === "off") updateSettings({ worktreeCleanup: { mode: "off" } });
                  else if (next === "custom")
                    updateSettings({ worktreeCleanup: { mode: "custom", rules: {} } });
                }}
              >
                <Toggle value="inherit">
                  <T>Inherit</T>
                </Toggle>
                <Toggle value="off">
                  <T>Off</T>
                </Toggle>
                <Toggle value="custom">
                  <T>Custom</T>
                </Toggle>
              </ToggleGroup>
            }
          />
        )}
        {(!isProjectScope || (!mixedModes && mode === "custom")) && (
          <>
            <SettingsRow
              title={
                terminology.kind === "jj"
                  ? gt("Delete merged workspaces")
                  : gt("Delete merged worktrees")
              }
              status={ruleStatus("worktreeOnMerge")}
              managedPaths={lockablePath("worktreeOnMerge")}
              description={
                terminology.kind === "jj"
                  ? gt(
                      "Remove workspaces whose pull request is merged and whose changes are included in the default bookmark.",
                    )
                  : gt("Once the pull request for the branch is merged.")
              }
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={
                    terminology.kind === "jj"
                      ? gt("Delete merged workspaces")
                      : gt("Delete merged worktrees")
                  }
                  checked={settings.worktreeOnMerge}
                  onCheckedChange={(worktreeOnMerge) => updateWorktree({ worktreeOnMerge })}
                />
              }
            />
            <SettingsRow
              title={
                terminology.kind === "jj"
                  ? gt("Delete unchanged workspaces")
                  : gt("Delete unchanged worktrees")
              }
              status={ruleStatus("worktreeUnchanged")}
              managedPaths={lockablePath("worktreeUnchanged")}
              description={
                terminology.kind === "jj"
                  ? gt("Remove workspaces with no changes beyond the default bookmark.")
                  : gt("No commits beyond the default branch.")
              }
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={
                    terminology.kind === "jj"
                      ? gt("Delete unchanged workspaces")
                      : gt("Delete unchanged worktrees")
                  }
                  checked={settings.worktreeUnchanged}
                  onCheckedChange={(worktreeUnchanged) => updateWorktree({ worktreeUnchanged })}
                />
              }
            />
            <SettingsRow
              title={
                terminology.kind === "jj"
                  ? gt("Delete workspaces with deleted threads")
                  : gt("Delete worktrees with deleted threads")
              }
              status={ruleStatus("worktreeOnDelete")}
              managedPaths={lockablePath("worktreeOnDelete")}
              description={
                terminology.kind === "jj"
                  ? gt(
                      "Remove unused workspaces when active or archived threads are deleted. Working-copy changes, conflicts, and commits no local or remote bookmark reaches are kept. Local files follow the keep rule below.",
                    )
                  : gt("When every thread using the worktree is deleted.")
              }
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={
                    terminology.kind === "jj"
                      ? gt("Delete workspaces with deleted threads")
                      : gt("Delete worktrees with deleted threads")
                  }
                  checked={settings.worktreeOnDelete}
                  onCheckedChange={(worktreeOnDelete) => updateWorktree({ worktreeOnDelete })}
                />
              }
            />
            <SettingsRow
              title={
                terminology.kind === "jj"
                  ? gt("Delete inactive workspaces")
                  : gt("Delete inactive worktrees")
              }
              status={ruleStatus("worktreeAfterDays")}
              managedPaths={lockablePath("worktreeAfterDays")}
              description={
                terminology.kind === "jj"
                  ? gt(
                      "Remove workspaces after their threads have been inactive for this many days. Changes and thread history are kept.",
                    )
                  : gt("No thread activity for this long.")
              }
              serverScoped={!isProjectScope}
              control={
                <RetentionControl
                  label={
                    terminology.kind === "jj"
                      ? gt("Delete inactive workspaces")
                      : gt("Delete inactive worktrees")
                  }
                  value={settings.worktreeAfterDays}
                  onChange={(worktreeAfterDays, onFailed) =>
                    updateWorktree({ worktreeAfterDays }, { onFailed })
                  }
                />
              }
            />
            <AdvancedSettings
              // The keep-when search result lands on this section, not its row.
              targetIds={["storage-worktrees", setting("storage-worktree-keep-when").id]}
            >
              {connectedEnvironments.length > 0 &&
                connectedEnvironments.every(
                  (environment) =>
                    environment.serverConfig?.environment.capabilities.settledWorktreeCleanup ===
                    true,
                ) && (
                  <SettingsRow
                    title={
                      terminology.kind === "jj"
                        ? gt("Delete settled workspaces")
                        : gt("Delete settled worktrees")
                    }
                    managedPaths={lockablePath("worktreeSettledAfterDays")}
                    status={[
                      ruleStatus("worktreeSettledAfterDays"),
                      environments.length > connectedEnvironments.length
                        ? gt("Offline machines will not get this setting")
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(". ")}
                    description={
                      terminology.kind === "jj"
                        ? gt(
                            "Remove workspaces this many days after their thread settles. Set 0 days to remove them at the next cleanup. Changes and thread history are kept.",
                          )
                        : gt(
                            "Remove worktrees this many days after their thread settles. Set 0 days to remove them at the next cleanup. Branches and thread history are kept.",
                          )
                    }
                    serverScoped={!isProjectScope}
                    control={
                      <RetentionControl
                        label={
                          terminology.kind === "jj"
                            ? gt("Delete settled workspaces")
                            : gt("Delete settled worktrees")
                        }
                        value={settings.worktreeSettledAfterDays}
                        minimum={0}
                        onChange={(worktreeSettledAfterDays, onFailed) =>
                          updateWorktree({ worktreeSettledAfterDays }, { onFailed })
                        }
                      />
                    }
                  />
                )}
              {connectedEnvironments.every(
                (environment) =>
                  environment.serverConfig?.environment.capabilities.storageCleanupRun === true,
              ) && (
                <SettingsRow
                  {...setting("storage-worktree-keep-when")}
                  status={ruleStatus("worktreeKeepWhen")}
                  managedPaths={lockablePath("worktreeKeepWhen")}
                  description={
                    terminology.kind === "jj"
                      ? settings.worktreeKeepWhen === "any-local-files"
                        ? gt(
                            "Any local files includes ignored files except node_modules. Untracked files, conflicts, and changes unreachable from bookmarks or remote bookmarks are kept.",
                          )
                        : settings.worktreeKeepWhen === "tracked-changes"
                          ? gt(
                              "Deletes untracked and ignored files, including .env. Tracked edits, conflicts, and changes unreachable from bookmarks or remote bookmarks are kept.",
                            )
                          : gt(
                              "Keeps edits and untracked files. Deletes ignored files, including .env. Conflicts and changes unreachable from bookmarks or remote bookmarks are kept.",
                            )
                      : settings.worktreeKeepWhen === "any-local-files"
                        ? gt("Includes ignored files, except node_modules.")
                        : settings.worktreeKeepWhen === "tracked-changes"
                          ? gt("Deletes untracked and ignored files, including .env.")
                          : gt(
                              "Keeps edits and untracked files. Deletes ignored files, including .env.",
                            )
                  }
                  serverScoped={!isProjectScope}
                  control={
                    <Select
                      value={ruleStatus("worktreeKeepWhen") ? null : settings.worktreeKeepWhen}
                      onValueChange={(next) => {
                        if (
                          next === "any-local-files" ||
                          next === "uncommitted-changes" ||
                          next === "tracked-changes"
                        )
                          updateWorktree({ worktreeKeepWhen: next });
                      }}
                    >
                      <SelectTrigger
                        variant="well"
                        size="compact"
                        aria-label={
                          terminology.kind === "jj"
                            ? gt("Keep workspaces with local changes")
                            : gt("Keep worktrees with local changes")
                        }
                      >
                        <SelectValue>
                          {ruleStatus("worktreeKeepWhen")
                            ? gt("Mixed")
                            : messages(KEEP_WHEN_LABELS[settings.worktreeKeepWhen])}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="end" alignItemWithTrigger={false}>
                        <SelectItem value="any-local-files">
                          <T>Any local files</T>
                        </SelectItem>
                        <SelectItem value="uncommitted-changes">
                          <T>Uncommitted changes</T>
                        </SelectItem>
                        <SelectItem value="tracked-changes">
                          <T>Edited tracked files</T>
                        </SelectItem>
                      </SelectPopup>
                    </Select>
                  }
                />
              )}
            </AdvancedSettings>
          </>
        )}
      </>
    </SettingsSection>
  );
}

/** Retention for logs and captures, and the manual cleanup run, which covers worktrees too. */
export function StorageCleanupSections() {
  const gt = useGT();
  const { scope, connectedEnvironments, targets } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const settings = scopedSettings.storageCleanup;
  const targetIdsKey = environmentIdsKey(targets.map((target) => target.environmentId).sort());
  const artifactsMixed =
    targets.length > 1 &&
    targets.some(
      (target) =>
        target.settings.storageCleanup.browserArtifactsAfterDays !==
        settings.browserArtifactsAfterDays,
    );
  const logsMixed =
    targets.length > 1 &&
    targets.some(
      (target) => target.settings.storageCleanup.logsAfterDays !== settings.logsAfterDays,
    );
  const settledArtifactsStatus = useDebouncedValue(`${targetIdsKey}:${artifactsMixed}`, 300);
  const settledLogsStatus = useDebouncedValue(`${targetIdsKey}:${logsMixed}`, 300);
  const artifactsStatus =
    targets.length > 1 && settledArtifactsStatus === `${targetIdsKey}:true`
      ? gt("Mixed across selected machines")
      : undefined;
  const logsStatus =
    targets.length > 1 && settledLogsStatus === `${targetIdsKey}:true`
      ? gt("Mixed across selected machines")
      : undefined;
  if (scope.kind === "project" || scope.kind === "checkout") return null;
  const update = (patch: Partial<StorageCleanupSettings>, options: SaveOptions) =>
    updateSettings({ storageCleanup: patch }, options);
  const databaseStorageNotice = (
    <DatabaseStorageNotice
      environments={connectedEnvironments.filter(
        (environment) =>
          environment.serverConfig?.environment.capabilities.databaseStorage === true,
      )}
    />
  );
  if (!supportsStorageCleanup(connectedEnvironments)) {
    return (
      <>
        {databaseStorageNotice}
        <SettingsSection id="storage-artifacts" title={gt("Artifacts and logs")} variant="plain">
          <StorageCleanupScopeNotice />
        </SettingsSection>
      </>
    );
  }

  return (
    <>
      {databaseStorageNotice}
      <SettingsSection id="storage-artifacts" title={gt("Artifacts and logs")}>
        <AnimatedHeight>
          <SettingsRow
            title={gt("Delete old browser artifacts")}
            status={artifactsStatus}
            managedPaths={["storageCleanup.browserArtifactsAfterDays"]}
            description={gt("Screenshots, recordings and traces from agent browsing.")}
            serverScoped
            control={
              <RetentionControl
                label={gt("Delete old browser artifacts")}
                value={settings.browserArtifactsAfterDays}
                onChange={(browserArtifactsAfterDays, onFailed) =>
                  update({ browserArtifactsAfterDays }, { onFailed })
                }
              />
            }
          />
        </AnimatedHeight>
        <AnimatedHeight>
          <SettingsRow
            title={gt("Delete old rotated logs")}
            status={logsStatus}
            managedPaths={["storageCleanup.logsAfterDays"]}
            description={gt("Current logs are always kept.")}
            serverScoped
            control={
              <RetentionControl
                label={gt("Delete old rotated logs")}
                value={settings.logsAfterDays}
                onChange={(logsAfterDays, onFailed) => update({ logsAfterDays }, { onFailed })}
              />
            }
          />
        </AnimatedHeight>
      </SettingsSection>
      <CleanupSection />
    </>
  );
}

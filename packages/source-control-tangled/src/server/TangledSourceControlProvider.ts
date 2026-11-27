import {
  SourceControlProviderError,
  SourceControlProviderKind,
  type ChangeRequest,
} from "@t3tools/contracts";
import {
  providerAuth,
  type SourceControlApiDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import {
  definition,
  isTangledHost,
  settings as tangledSettings,
  parseTangledRemote,
  parseTangledRepository,
  TANGLED_WEB_HOST,
  type TangledRepositoryRef,
} from "../shared/definition.ts";
import * as TangledApi from "./TangledApi.ts";
import { TangledAuth } from "./TangledAuth.ts";
import * as TangledRound from "./tangledRound.ts";

const KIND = SourceControlProviderKind.make("tangled");
const SIGN_IN_HINT = "Sign in to Tangled in Settings → Source control → Tangled.";
const PAGE_SIZE = 100;
/** Tickets read per state looking for a branch's pull request; Tangled cannot filter by branch. */
const BRANCH_SCAN_LIMIT = 200;
/** Where `tg repo create` and the web put a new repository unless told otherwise. */
const DEFAULT_KNOT = "knot1.tangled.sh";
const KNOT_HOST =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/u;
const REPOSITORY_NAME = /^(?!\.)[A-Za-z0-9._-]{1,100}(?<!\.)$/u;
/** Waiting for the mirror, then for the index to list the round, stays under this. */
const PUSH_FOLLOW_LIMIT = Duration.seconds(45);

/**
 * Where git reaches a repository. Tangled's web host relays its own knots; a self-hosted knot is
 * reached directly, by repo DID, because its SSH is often closed to everyone but its owner.
 */
export function repositoryGitUrls(
  repository: Pick<TangledApi.TangledRepository, "knot" | "repoDid">,
  path: string,
) {
  return isTangledHost(repository.knot)
    ? { url: `https://${TANGLED_WEB_HOST}/${path}`, sshUrl: `git@${TANGLED_WEB_HOST}:${path}` }
    : {
        url: `https://${repository.knot}/${repository.repoDid}`,
        sshUrl: `git@${repository.knot}:${repository.repoDid}`,
      };
}

const latest = <A>(items: ReadonlyArray<A>) => items.at(-1);

const toUtc = (...candidates: ReadonlyArray<string | null | undefined>) =>
  Option.fromNullishOr(
    candidates
      .flatMap((value) => (value ? Option.toArray(DateTime.make(value)) : []))
      .toSorted((left, right) => DateTime.toEpochMillis(right) - DateTime.toEpochMillis(left))[0],
  );

export const makeDiscovery = Effect.gen(function* () {
  const auth = yield* TangledAuth;
  return {
    type: "api",
    kind: KIND,
    label: "Tangled",
    installHint: SIGN_IN_HINT,
    appSignIn: true,
    probeAuth: auth.viewer.pipe(
      Effect.map(
        Option.match({
          onNone: () =>
            providerAuth({
              status: "unauthenticated",
              host: TANGLED_WEB_HOST,
              detail: SIGN_IN_HINT,
            }),
          onSome: (viewer) =>
            providerAuth({
              status: "authenticated",
              host: TANGLED_WEB_HOST,
              account: viewer.handle,
            }),
        }),
      ),
    ),
  } satisfies SourceControlApiDiscoverySpec;
});

/** The provider, and a wait for the rounds pushes left submitting in the background. */
export const makeWithPushFollowers = Effect.gen(function* () {
  const api = yield* TangledApi.TangledApi;
  const auth = yield* TangledAuth;
  const host = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const pushFollowers = yield* FiberSet.make();

  const error = (operation: string, cwd: string, detail: string, cause?: unknown) =>
    new SourceControlProviderError({
      provider: KIND,
      operation,
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const fromApi = (operation: string, cwd: string) => (cause: TangledApi.TangledError) =>
    error(
      operation,
      cwd,
      cause._tag === "TangledAuthError" ? `${cause.detail} ${SIGN_IN_HINT}` : cause.detail,
      cause,
    );

  const remoteUrlOf = (cwd: string) =>
    host.git
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.flatMap((remote) => host.git.readConfigValue(cwd, `remote.${remote}.url`)));

  const resolveTarget = Effect.fn("TangledSourceControlProvider.resolveTarget")(function* (
    operation: string,
    input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository?: string;
    },
  ) {
    let reference: TangledRepositoryRef | null =
      input.repository === undefined ? null : parseTangledRepository(input.repository);
    if (reference === null) {
      const remoteUrl =
        input.context?.remoteUrl ??
        (yield* remoteUrlOf(input.cwd).pipe(
          Effect.mapError((cause) =>
            error(operation, input.cwd, "Could not read the Tangled remote.", cause),
          ),
        ));
      reference = remoteUrl ? (parseTangledRemote(remoteUrl)?.repository ?? null) : null;
    }
    if (reference === null)
      return yield* error(operation, input.cwd, "No Tangled repository remote was found.");
    return yield* api
      .resolveRepository(reference)
      .pipe(Effect.mapError(fromApi(operation, input.cwd)));
  });

  const toChangeRequest = Effect.fn("TangledSourceControlProvider.toChangeRequest")(function* (
    target: TangledApi.TangledRepository,
    ticket: TangledApi.TangledTicket,
    rounds: ReadonlyArray<TangledApi.TangledRound>,
  ) {
    const number = TangledApi.ticketNumber(ticket.rkey);
    const round = latest(rounds);
    if (number === null || round === undefined || ticket.targetBranch.length === 0) return null;
    const crossRepository = round.sourceRepoDid !== target.repoDid;
    const source = crossRepository
      ? yield* api
          .resolveRepository({ kind: "repo-did", repoDid: round.sourceRepoDid })
          .pipe(Effect.option, Effect.map(Option.getOrNull))
      : target;
    return {
      provider: KIND,
      number,
      title: ticket.title.trim() || `Pull request ${number}`,
      url: TangledApi.pullRequestUrl(target, number),
      baseRefName: ticket.targetBranch,
      headRefName: round.sourceBranch ?? round.headOid,
      headSha: round.headOid,
      state: TangledApi.pullState(ticket.state),
      closedAt: ticket.state === "closed" ? ticket.stateUpdatedAt : null,
      mergedAt: ticket.state === "completed" ? ticket.stateUpdatedAt : null,
      updatedAt: toUtc(ticket.stateUpdatedAt, round.createdAt, ticket.createdAt),
      isCrossRepository: crossRepository,
      headRepositoryNameWithOwner: source ? TangledApi.repositoryPath(source) : null,
      headRepositoryOwnerLogin: source ? (source.ownerHandle ?? source.ownerDid) : null,
      repositoryKey: TangledApi.repositoryKey(target),
    } satisfies ChangeRequest;
  });

  const getPull = Effect.fn("TangledSourceControlProvider.getPull")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) {
    const operation = "getChangeRequest";
    const reference = input.reference.trim();
    const link = URL.canParse(reference)
      ? definition.parseChangeRequestUrl(new URL(reference))
      : null;
    const number = link?.number ?? Number(/^#?([1-9]\d*)$/u.exec(reference)?.[1]);
    if (!Number.isSafeInteger(number))
      return yield* error(
        operation,
        input.cwd,
        "A Tangled pull request is a number or a tangled.org pull request URL.",
      );
    const target = yield* resolveTarget(operation, {
      ...input,
      ...(link === null ? {} : { repository: link.repository }),
    });
    const ticket = yield* api
      .getTicket({ repoDid: target.repoDid, rkey: String(number) })
      .pipe(Effect.mapError(fromApi(operation, input.cwd)));
    if (ticket.targetBranch.length === 0)
      return yield* error(operation, input.cwd, `#${number} is an issue, not a pull request.`);
    const rounds = yield* api
      .listRounds(ticket.uri)
      .pipe(Effect.mapError(fromApi(operation, input.cwd)));
    const pull = yield* toChangeRequest(target, ticket, rounds);
    if (pull === null)
      return yield* error(operation, input.cwd, `Pull request #${number} has no submitted round.`);
    return { pull, target, rounds };
  });

  const refineRepositoryIdentity: NonNullable<
    SourceControlProvider.SourceControlProvider["Service"]["refineRepositoryIdentity"]
  > = Effect.fn("TangledSourceControlProvider.refineRepositoryIdentity")(function* ({ identity }) {
    const remote = parseTangledRemote(identity.locator.remoteUrl);
    if (remote === null || (identity.provider !== undefined && identity.provider !== KIND))
      return identity;
    const repository = yield* api
      .resolveRepository(remote.repository)
      .pipe(
        Effect.mapError(
          fromApi("refineRepositoryIdentity", identity.rootPath ?? identity.locator.remoteUrl),
        ),
      );
    // The repo DID is the key, so renames and handle changes keep the project's identity.
    return {
      ...identity,
      provider: KIND,
      canonicalKey: TangledApi.repositoryKey(repository),
      displayName: TangledApi.repositoryPath(repository),
      owner: repository.ownerHandle ?? repository.ownerDid,
      name: repository.name,
      webUrl: TangledApi.webUrl(repository),
    };
  });

  const listChangeRequests: SourceControlProvider.SourceControlProvider["Service"]["listChangeRequests"] =
    Effect.fn("TangledSourceControlProvider.listChangeRequests")(function* (input) {
      const operation = "listChangeRequests";
      const target = yield* resolveTarget(operation, input);
      const branch = SourceControlProvider.sourceBranch(input);
      const owner = SourceControlProvider.sourceControlRefFromInput(input)?.owner?.toLowerCase();
      const limit = input.limit ?? 20;
      const viewer = Option.getOrNull(yield* auth.viewer);
      const states: ReadonlyArray<TangledApi.TicketState> =
        input.state === "all"
          ? ["open", "completed", "closed"]
          : [TangledApi.ticketStateOf(input.state)];
      const found: Array<ChangeRequest> = [];
      for (const state of states) {
        let cursor: string | null = null;
        let scanned = 0;
        do {
          const page: TangledApi.TangledPage<TangledApi.TangledTicket> = yield* api
            .listPulls({ repoDid: target.repoDid, state, limit: PAGE_SIZE, cursor })
            .pipe(Effect.mapError(fromApi(operation, input.cwd)));
          scanned += page.items.length;
          // Bobbin ignores its author filter, so narrowing to the viewer's own happens here.
          const candidates = page.items.filter(
            (ticket) =>
              TangledApi.ticketNumber(ticket.rkey) !== null &&
              ticket.targetBranch.length > 0 &&
              (viewer === null || ticket.authorDid === viewer.did),
          );
          const matches = yield* Effect.forEach(
            candidates,
            (ticket) =>
              api
                .listRounds(ticket.uri)
                .pipe(
                  Effect.map((rounds) =>
                    latest(rounds)?.sourceBranch === branch ? { ticket, rounds } : null,
                  ),
                ),
            { concurrency: 8 },
          ).pipe(Effect.mapError(fromApi(operation, input.cwd)));
          for (const match of matches) {
            if (match === null || found.length >= limit) continue;
            const pull = yield* toChangeRequest(target, match.ticket, match.rounds);
            if (pull === null) continue;
            if (owner !== undefined && pull.headRepositoryOwnerLogin?.toLowerCase() !== owner)
              continue;
            found.push(pull);
          }
          cursor = page.cursor;
        } while (cursor !== null && scanned < BRANCH_SCAN_LIMIT && found.length < limit);
      }
      return found;
    });

  /** Waits for Tangled's mirror to see the push, then submits it as the pull request's next round. */
  const followPush = Effect.fn("TangledSourceControlProvider.followPush")(function* (
    input: { readonly cwd: string; readonly branch: string; readonly headSha: string },
    target: TangledApi.TangledRepository,
    pull: ChangeRequest,
  ) {
    const source = {
      target,
      targetBranch: pull.baseRefName,
      sourceRepoDid: target.repoDid,
      sourceBranch: input.branch,
    };
    yield* TangledRound.awaitMirroredHead(api, {
      repoDid: target.repoDid,
      branch: input.branch,
      head: input.headSha,
    });
    const round = yield* TangledRound.proposeRound(api, source);
    yield* TangledRound.submitRound(api, {
      ...source,
      ...round,
      ticketUri: TangledApi.ticketUri(target.repoDid, String(pull.number)),
    });
  });

  /**
   * Tangled makes no round from a push, so a push to the viewer's open pull request's branch is
   * submitted as its next round once the mirror has it, after the push returns; a failure is
   * logged and Resubmit offers it again. A fork's pull request lives upstream, which the fork's
   * remote does not name, so only the pushed repository's own pull requests are followed.
   */
  const followPushedBranch = Effect.fn("TangledSourceControlProvider.followPushedBranch")(
    function* (input: { readonly cwd: string; readonly branch: string; readonly headSha: string }) {
      const operation = "branchPushed";
      const stale = (yield* listChangeRequests({
        cwd: input.cwd,
        headSelector: input.branch,
        state: "open",
      })).filter((pull) => !pull.isCrossRepository && pull.headSha !== input.headSha);
      if (stale.length === 0) return;
      const target = yield* resolveTarget(operation, input);
      yield* Effect.forEach(
        stale,
        (pull) =>
          followPush(input, target, pull).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Tangled did not take the pushed branch as a new round.", {
                branch: input.branch,
                number: pull.number,
                detail: cause.detail,
              }),
            ),
          ),
        { discard: true },
      );
    },
  );

  const branchPushed: NonNullable<
    SourceControlProvider.SourceControlProvider["Service"]["branchPushed"]
  > = Effect.fn("TangledSourceControlProvider.branchPushed")(function* (input) {
    if (Option.isNone(yield* auth.viewer)) return;
    yield* FiberSet.run(
      pushFollowers,
      followPushedBranch(input).pipe(
        Effect.timeoutOption(PUSH_FOLLOW_LIMIT),
        Effect.catch((cause) =>
          Effect.logWarning("Could not find the pull requests a push should update.", {
            branch: input.branch,
            detail: cause.detail,
          }),
        ),
      ),
    );
  });

  /**
   * A new repository is minted by a knot and claimed by a declaration on the owner's PDS, as
   * `tg repo create` and the web do. The declaration is looked for first so a name clash never
   * mints a repository at all.
   */
  const createRepository: SourceControlProvider.SourceControlProvider["Service"]["createRepository"] =
    Effect.fn("TangledSourceControlProvider.createRepository")(function* (input) {
      const operation = "createRepository";
      const refuse = (detail: string) => error(operation, input.cwd, detail);
      if (input.visibility !== "public")
        return yield* refuse("Tangled repositories are public. Create a public one instead.");
      const viewer = Option.getOrNull(yield* auth.viewer);
      if (viewer === null) return yield* refuse(SIGN_IN_HINT);
      const configured = yield* host.settings.get.pipe(
        Effect.map(
          (saved) =>
            readSourceControlHostSettings(tangledSettings, saved.sourceControlHosts[KIND]).knot,
        ),
        Effect.orElseSucceed(() => ""),
      );
      const knot =
        configured
          .toLowerCase()
          .replace(/^https?:\/\//u, "")
          .replace(/\/+$/u, "") || DEFAULT_KNOT;
      if (!KNOT_HOST.test(knot))
        return yield* refuse(
          `"${configured}" is not a knot's host name. Fix it in Settings → Source control → Tangled.`,
        );
      const [owner = "", ...rest] = input.repository.split("/");
      const name = rest.join("/").replace(/\.git$/iu, "");
      if (![viewer.handle, viewer.did].some((own) => own.toLowerCase() === owner.toLowerCase()))
        return yield* refuse(`T3 Code creates Tangled repositories only as ${viewer.handle}.`);
      if (!REPOSITORY_NAME.test(name) || name.includes("..") || name.toLowerCase() === "self")
        return yield* refuse(
          "Use letters, numbers, single periods, hyphens and underscores in the name, up to 100 of them, not starting or ending with a period.",
        );
      const failed = fromApi(operation, input.cwd);
      const slot = { collection: TangledApi.COLLECTION.declaration, rkey: name.toLowerCase() };
      if (Option.isSome(yield* auth.getRecord(slot).pipe(Effect.mapError(failed))))
        return yield* refuse(`You already have a Tangled repository named ${name}.`);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const repoDid = yield* api
        .createRepo({ knot, name, createdAt })
        .pipe(Effect.mapError(failed));
      yield* auth
        .createRecord({
          ...slot,
          record: { $type: TangledApi.COLLECTION.declaration, repo: repoDid, createdAt },
        })
        .pipe(
          // A failed claim may still have landed, so the slot decides whether to undo the mint.
          Effect.catch((cause) =>
            auth.getRecord(slot).pipe(
              Effect.flatMap(
                Option.match({
                  onSome: () => Effect.void,
                  onNone: () =>
                    api
                      .deleteRepo({ knot, repoDid })
                      .pipe(
                        Effect.flatMap(() =>
                          refuse(
                            `Tangled did not claim the new repository for you: ${cause.detail}`,
                          ),
                        ),
                      ),
                }),
              ),
              Effect.catchIf(
                (failure) => failure._tag !== "SourceControlProviderError",
                () =>
                  refuse(
                    `${knot} made the repository as ${repoDid}, but it could not be claimed for you or removed again: ${cause.detail}`,
                  ),
              ),
            ),
          ),
        );
      // The first push reads the repository through Tangled's index, which learns of it shortly.
      yield* api
        .resolveRepository({ kind: "repo-did", repoDid })
        .pipe(
          Effect.retry(Schedule.spaced(Duration.seconds(1))),
          Effect.timeoutOption(Duration.seconds(10)),
          Effect.ignore,
        );
      // Remotes name the repo DID, so they outlive renames of the repository or its owner.
      return {
        nameWithOwner: `${viewer.handle}/${name}`,
        ...repositoryGitUrls({ knot, repoDid }, repoDid),
      };
    });

  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: KIND,
    refineRepositoryIdentity,
    getChangeRequest: Effect.fn("TangledSourceControlProvider.getChangeRequest")((input) =>
      getPull(input).pipe(Effect.map(({ pull }) => pull)),
    ),
    listChangeRequests,
    branchPushed,
    createChangeRequest: Effect.fn("TangledSourceControlProvider.createChangeRequest")(
      function* (input) {
        const operation = "createChangeRequest";
        const target = yield* resolveTarget(operation, {
          ...input,
          ...(input.target?.repository ? { repository: input.target.repository } : {}),
        });
        const sourceRef = SourceControlProvider.sourceControlRefFromInput(input);
        const source = sourceRef?.repository
          ? yield* resolveTarget(operation, { cwd: input.cwd, repository: sourceRef.repository })
          : target;
        const roundSource = {
          target,
          targetBranch: input.target?.refName ?? input.baseRefName,
          sourceRepoDid: source.repoDid,
          sourceBranch: SourceControlProvider.sourceBranch(input),
        };
        const failed = fromApi(operation, input.cwd);
        // The branch was pushed already; propose what the host has, as `tg pr create` does.
        const round = yield* TangledRound.proposeRound(api, roundSource).pipe(
          Effect.mapError(failed),
        );
        const body = yield* fileSystem
          .readFileString(input.bodyFile)
          .pipe(
            Effect.mapError((cause) =>
              error(operation, input.cwd, "Could not read the pull request description.", cause),
            ),
          );
        const ticket = yield* api
          .write({
            service: "knot",
            repository: target,
            nsid: TangledApi.NSID.createRecord,
            body: {
              collection: TangledApi.COLLECTION.ticket,
              record: {
                $type: TangledApi.COLLECTION.ticket,
                title: { $type: "org.tangled.markup.markdown#inline", text: input.title },
                ...(body.trim().length === 0
                  ? {}
                  : { body: { $type: "org.tangled.markup.markdown", text: body } }),
                state: "open",
                targetBranch: roundSource.targetBranch,
                createdAt: DateTime.formatIso(yield* DateTime.now),
              },
            },
          })
          .pipe(Effect.mapError(failed));
        if (ticket === null)
          return yield* error(
            operation,
            input.cwd,
            "Tangled accepted the pull request without naming it.",
          );
        const rkey = TangledApi.rkeyOf(ticket.uri);
        yield* TangledRound.submitRound(api, {
          ...roundSource,
          ...round,
          ticketUri: ticket.uri,
        }).pipe(
          Effect.catch((cause) =>
            // Only a definite refusal leaves nothing behind worth keeping; a lost reply may not.
            (TangledApi.isDefiniteRejection(cause)
              ? api
                  .write({
                    service: "knot",
                    repository: target,
                    nsid: TangledApi.NSID.deleteRecord,
                    body: {
                      collection: TangledApi.COLLECTION.ticket,
                      rkey,
                      swapRecord: ticket.cid,
                    },
                  })
                  .pipe(Effect.ignore)
              : Effect.void
            ).pipe(Effect.andThen(Effect.fail(failed(cause)))),
          ),
        );
      },
    ),
    getRepositoryCloneUrls: Effect.fn("TangledSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const repository = yield* resolveTarget("getRepositoryCloneUrls", input);
        const path = TangledApi.repositoryPath(repository);
        return { nameWithOwner: path, ...repositoryGitUrls(repository, path) };
      },
    ),
    createRepository,
    getDefaultBranch: Effect.fn("TangledSourceControlProvider.getDefaultBranch")((input) =>
      resolveTarget("getDefaultBranch", input).pipe(
        Effect.map((repository) => repository.defaultBranch),
      ),
    ),
    checkoutChangeRequest: Effect.fn("TangledSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const operation = "checkoutChangeRequest";
        const { pull, rounds } = yield* getPull(input);
        const round = latest(rounds);
        if (round === undefined || round.sourceBranch === null)
          return yield* error(operation, input.cwd, "The pull request names no source branch.");
        const remoteBranchName = round.sourceBranch;
        const contextRemote = input.context ? parseTangledRemote(input.context.remoteUrl) : null;
        const contextRepoDid =
          contextRemote === null
            ? null
            : yield* api.resolveRepository(contextRemote.repository).pipe(
                Effect.map((repository) => repository.repoDid),
                Effect.orElseSucceed(() => null),
              );
        const ssh = input.context ? !/^https?:\/\//iu.test(input.context.remoteUrl) : true;
        const git = host.git;
        yield* Effect.gen(function* () {
          const context = input.context;
          const remoteName =
            context !== undefined && contextRepoDid === round.sourceRepoDid
              ? context.remoteName
              : yield* api
                  .resolveRepository({ kind: "repo-did", repoDid: round.sourceRepoDid })
                  .pipe(
                    Effect.mapError(fromApi(operation, input.cwd)),
                    // A repo DID never changes, so the remote outlives renames of the source.
                    Effect.map((source) => repositoryGitUrls(source, round.sourceRepoDid)),
                    Effect.flatMap((urls) =>
                      git.ensureRemote({
                        cwd: input.cwd,
                        preferredName: "tangled",
                        url: ssh ? urls.sshUrl : urls.url,
                      }),
                    ),
                  );
          const localBranch = pull.isCrossRepository
            ? `pr-${pull.number}/${remoteBranchName}`
            : remoteBranchName;
          const branches = yield* git.listLocalBranchNames(input.cwd);
          const remoteBranch = { cwd: input.cwd, remoteName, remoteBranch: remoteBranchName };
          if (input.force !== true && !branches.includes(localBranch))
            yield* git.fetchRemoteBranch({ ...remoteBranch, localBranch });
          else yield* git.fetchRemoteTrackingBranch(remoteBranch);
          if (input.force === true)
            yield* git.execute({
              operation: "TangledSourceControlProvider.checkoutChangeRequest",
              cwd: input.cwd,
              args: [
                "checkout",
                "--no-track",
                "-B",
                localBranch,
                `refs/remotes/${remoteName}/${remoteBranchName}`,
                "--",
              ],
            });
          yield* git.setBranchUpstream({ ...remoteBranch, branch: localBranch });
          yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
        }).pipe(
          Effect.mapError((cause) =>
            error(operation, input.cwd, "Could not check out the Tangled pull request.", cause),
          ),
        );
      },
    ),
  });
  return { provider, awaitPushFollowers: FiberSet.awaitEmpty(pushFollowers) };
});

export const make = makeWithPushFollowers.pipe(Effect.map(({ provider }) => provider));

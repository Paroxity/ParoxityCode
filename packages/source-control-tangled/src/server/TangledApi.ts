import type { ChangeRequestState } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import {
  isDid,
  TANGLED_WEB_HOST,
  tangledRepositoryKey,
  type TangledRepositoryRef,
} from "../shared/definition.ts";
import { PublicHostGuard } from "./publicHost.ts";
import { TangledAuth, type TangledAuthError } from "./TangledAuth.ts";

/**
 * Every XRPC method T3 calls, in one place: Tangled's API is young and renames methods, so a
 * rename is a one-line change here.
 */
export const NSID = {
  resolveIdentity: "blue.microcosm.identity.resolveMiniDoc",
  getRepoByName: "org.tangled.repo.getRepoByName",
  getRepoByRepoDid: "org.tangled.repo.getRepoByRepoDid",
  listPulls: "org.tangled.repo.listPulls",
  listCollaborators: "org.tangled.repo.listCollaborators",
  getTicketView: "org.tangled.track.getTicketView",
  listPatches: "org.tangled.temp.review.listPatches",
  listComments: "org.tangled.feed.listComments",
  getRef: "org.tangled.temp.git.getRef",
  getMergeBase: "org.tangled.temp.git.getMergeBase",
  listCommits: "org.tangled.temp.git.listCommits",
  getBlob: "org.tangled.temp.git.getBlob",
  getDiff: "sh.tangled.git.temp2.getDiff",
  getInterdiff: "sh.tangled.git.temp2.getInterdiff",
  mergeCheck: "sh.tangled.git.temp2.mergeCheck",
  queryPipelines: "org.tangled.ci.queryPipelines",
  getRecord: "com.atproto.repo.getRecord",
  createRecord: "com.atproto.repo.createRecord",
  putRecord: "com.atproto.repo.putRecord",
  deleteRecord: "com.atproto.repo.deleteRecord",
  submitPatch: "org.tangled.review.submitPatch",
  mergeCommit: "sh.tangled.git.mergeCommit",
  receivePack: "org.tangled.git.receivePack",
  createRepo: "org.tangled.repo.createRepo",
  deleteRepo: "org.tangled.repo.deleteRepo",
} as const;

export const COLLECTION = {
  ticket: "org.tangled.track.ticket",
  comment: "org.tangled.feed.comment",
  /** On the owner's PDS, keyed by the repository's lowercased name, claiming its repo DID. */
  declaration: "org.tangled.repo.declaration",
} as const;

/** Tangled's index, which also resolves identities. */
export const BOBBIN = "https://api.tangled.org";
const BOBBIN_HOST = new URL(BOBBIN).host;
const TIMEOUT = Duration.seconds(30);
const NO_REDIRECT: RequestInit = { redirect: "manual" };
const IDENTITY_TTL = Duration.minutes(30);
const REPOSITORY_TTL = Duration.minutes(10);
const ROUNDS_TTL = Duration.minutes(1);
// Opening a pull request reads its ticket for the detail, checks, activity and permissions.
const TICKET_TTL = Duration.seconds(10);
// Paging a diff, or expanding a file's context, rereads the same comparison.
const DIFF_TTL = Duration.minutes(1);
const DIFF_CAPACITY = 32;
const CACHE_CAPACITY = 2_000;
const PAGE_SIZE = 100;
const MAX_LISTED = 1_000;
const MAX_BLOB_BYTES = 1024 * 1024;

export class TangledApiError extends Schema.TaggedError<TangledApiError>()("TangledApiError", {
  operation: Schema.String,
  reason: Schema.Literals(["not-found", "unauthenticated", "rate-limited", "conflict", "failed"]),
  status: Schema.NullOr(Schema.Int),
  /** The XRPC error name, as `InvalidSwap` or `MergeConflict`. */
  error: Schema.optional(Schema.String),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Tangled ${this.operation} failed: ${this.detail}`;
  }
}

export type TangledError = TangledApiError | TangledAuthError;

/** A 4xx other than a timeout or a throttle: the host refused, so nothing was written. */
export const isDefiniteRejection = (error: TangledError) =>
  error._tag === "TangledApiError" &&
  error.status !== null &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 408 &&
  error.status !== 429;

const Markdown = Schema.Struct({ text: Schema.String });
const StrongRef = Schema.Struct({ uri: Schema.String, cid: Schema.String });
const Cursor = Schema.optional(Schema.NullOr(Schema.String));

const Manifest = Schema.Struct({
  uri: Schema.String,
  knot: Schema.optional(Schema.NullOr(Schema.String)),
  defaultBranch: Schema.optional(Schema.NullOr(Schema.String)),
  value: Schema.Struct({
    declaration: Schema.Struct({ name: Schema.String, owner: Schema.String }),
    spindle: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

export const MiniDoc = Schema.Struct({
  did: Schema.String,
  handle: Schema.String,
  pds: Schema.optional(Schema.String),
});

/** A ticket's own fields, which the listing nests under `value` and the view inlines. */
const TicketFields = Schema.Struct({
  title: Markdown,
  body: Schema.optional(Schema.NullOr(Markdown)),
  targetBranch: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
});

const TicketItem = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  author: Schema.String,
  state: Schema.String,
  stateUpdatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  commentCount: Schema.optional(Schema.Number),
  value: TicketFields,
});

const TicketView = Schema.Struct({
  ...TicketFields.fields,
  uri: Schema.String,
  cid: Schema.String,
  author: MiniDoc,
  state: Schema.String,
});

const Patch = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  value: Schema.Struct({
    base: Schema.Struct({ oid: Schema.String }),
    head: Schema.Struct({ oid: Schema.String }),
    source: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          branch: Schema.optional(Schema.String),
          repo: Schema.optional(Schema.String),
        }),
      ),
    ),
    createdAt: Schema.String,
  }),
});

const Comment = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  editor: Schema.String,
  body: Schema.optional(Schema.NullOr(Markdown)),
  createdAt: Schema.String,
  replyTo: Schema.optional(Schema.NullOr(StrongRef)),
});

const Collaborators = Schema.Struct({
  items: Schema.Array(Schema.Struct({ subject: Schema.String })),
});
const Ref = Schema.Struct({ oid: Schema.String });
const MergeBase = Schema.Struct({ commit: Schema.String });

const Signature = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  when: Schema.String,
});
const Commit = Schema.Struct({
  oid: Schema.String,
  parents: Schema.Array(Schema.String),
  author: Signature,
  committer: Schema.optional(Signature),
  message: Schema.String,
  extraHeaders: Schema.optional(
    Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
  ),
});
const Commits = Schema.Struct({ commits: Schema.Array(Commit) });

const DiffSide = Schema.Struct({
  path: Schema.String,
  oid: Schema.String,
  size: Schema.Number,
  isBinary: Schema.Boolean,
  isSubmodule: Schema.optional(Schema.Boolean),
  /** An interdiff's left side is a tree rebased for that one answer, so its text comes inline. */
  content: Schema.optional(Schema.String),
});
const FileDiff = Schema.Struct({
  lhsSrc: DiffSide,
  rhsSrc: DiffSide,
  hunks: Schema.Array(
    Schema.Struct({ novelLhs: Schema.Array(Schema.Number), novelRhs: Schema.Array(Schema.Number) }),
  ),
});
const Diffs = Schema.Struct({ diffs: Schema.Array(FileDiff) });

const MergeCheck = Schema.Struct({
  isConflicted: Schema.Boolean,
  conflicts: Schema.Array(Schema.Struct({ filename: Schema.String })),
});

const Workflow = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  status: Schema.String,
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  finishedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const Pipeline = Schema.Struct({
  id: Schema.String,
  commit: Schema.String,
  createdAt: Schema.String,
  trigger: Schema.optional(Schema.Struct({ $type: Schema.optional(Schema.String) })),
  workflows: Schema.Array(Workflow),
});
const Pipelines = Schema.Struct({ pipelines: Schema.Array(Pipeline) });

const RecordView = Schema.Struct({
  uri: Schema.String,
  cid: Schema.String,
  value: Schema.Record(Schema.String, Schema.Unknown),
});
const Receipt = Schema.Struct({ uri: Schema.String, cid: Schema.String });
const CreatedRepo = Schema.Struct({ did: Schema.String });
const XrpcProblem = Schema.Struct({
  error: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

export interface TangledRepository {
  readonly repoDid: string;
  readonly ownerDid: string;
  /** Null when the owner's handle does not resolve, so the repository has no web path. */
  readonly ownerHandle: string | null;
  readonly name: string;
  readonly knot: string;
  readonly defaultBranch: string | null;
  /** The repository's spindle as a `did:web`, or null when it runs no CI. */
  readonly spindle: string | null;
}

/** `owner/name` as the web shows it, with the owner's DID when it has no handle. */
export const repositoryPath = (repository: TangledRepository) =>
  `${repository.ownerHandle ?? repository.ownerDid}/${repository.name}`;

export const repositoryKey = (repository: TangledRepository) =>
  tangledRepositoryKey({ kind: "repo-did", repoDid: repository.repoDid });

export const webUrl = (repository: TangledRepository) =>
  `https://${TANGLED_WEB_HOST}/${repositoryPath(repository)}`;

export const pullRequestUrl = (repository: TangledRepository, number: number) =>
  `${webUrl(repository)}/pulls/${number}`;

export type TicketState = "open" | "closed" | "completed";

export const pullState = (state: TicketState): ChangeRequestState =>
  state === "completed" ? "merged" : state;

export const ticketStateOf = (state: ChangeRequestState): TicketState =>
  state === "merged" ? "completed" : state;

/** The last segment of an `at://` URI: its record key. */
export const rkeyOf = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);

/** Pull request numbers are ticket keys, which the knot mints as integers; any other key is skipped. */
export const ticketNumber = (rkey: string): number | null => {
  const number = /^[1-9]\d*$/u.test(rkey) ? Number(rkey) : Number.NaN;
  return Number.isSafeInteger(number) ? number : null;
};

export interface TangledTicket {
  readonly uri: string;
  readonly cid: string;
  /** The ticket's record key; a pull request's number when it is an integer. */
  readonly rkey: string;
  readonly authorDid: string;
  readonly title: string;
  readonly body: string;
  readonly state: TicketState;
  readonly stateUpdatedAt: string | null;
  readonly targetBranch: string;
  readonly createdAt: string;
  readonly commentCount: number;
}

/** One immutable submission of a pull request: the commit range reviewers see. */
export interface TangledRound {
  /** 1 for the first submission. */
  readonly round: number;
  readonly uri: string;
  readonly cid: string;
  readonly baseOid: string;
  readonly headOid: string;
  readonly sourceRepoDid: string;
  readonly sourceBranch: string | null;
  readonly createdAt: string;
}

export interface TangledComment {
  readonly uri: string;
  readonly cid: string;
  readonly authorDid: string;
  readonly body: string;
  readonly createdAt: string;
  readonly replyTo: string | null;
}

export type TangledCommit = typeof Commit.Type;
export type TangledFileDiff = typeof FileDiff.Type;
export type TangledPipeline = typeof Pipeline.Type;

export interface TangledPage<A> {
  readonly items: ReadonlyArray<A>;
  readonly cursor: string | null;
}

type RoundRange = Pick<TangledRound, "baseOid" | "headOid" | "sourceRepoDid">;

const ticketState = (state: string): TicketState =>
  state === "closed"
    ? "closed"
    : state === "completed" || state === "merged"
      ? "completed"
      : "open";

/** `did:web:<host>`, with a port written `%3A`, as knots and spindles name themselves. */
const serviceDid = (host: string) => `did:web:${host.replaceAll(":", "%3A")}`;

/** The host a `did:web` names; null for any other DID. */
const hostOfServiceDid = (did: string) =>
  did.startsWith("did:web:") ? decodeURIComponent(did.slice("did:web:".length)) : null;

export const ticketUri = (repoDid: string, rkey: string) =>
  `at://${repoDid}/${COLLECTION.ticket}/${rkey}`;

const repoDidOfUri = (uri: string) => uri.replace(/^at:\/\//u, "").split("/")[0] ?? "";

/**
 * A procedure authorized by a service-auth token minted for exactly this call: a record write,
 * patch or repository removal on the repository's knot, or a merge through bobbin.
 */
export type TangledWrite =
  | {
      readonly service: "knot" | "bobbin";
      readonly repository: TangledRepository;
      readonly nsid: string;
      readonly body: Record<string, unknown>;
    }
  | {
      /** A knot's own procedure, as `createRepo`, authorized for the knot rather than a repository. */
      readonly service: "knot-host";
      readonly knot: string;
      readonly nsid: string;
      readonly body: Record<string, unknown>;
    };

export class TangledApi extends Context.Service<
  TangledApi,
  {
    /** Handle or DID to both; cached. */
    readonly resolveIdentity: (
      identifier: string,
    ) => Effect.Effect<{ readonly did: string; readonly handle: string | null }, TangledApiError>;
    /** Cached under the reference and under the repo DID it resolves to. */
    readonly resolveRepository: (
      reference: TangledRepositoryRef,
    ) => Effect.Effect<TangledRepository, TangledApiError>;
    /** The repository as last resolved, without asking Tangled; none when it is not held. */
    readonly cachedRepository: (
      reference: TangledRepositoryRef,
    ) => Effect.Effect<Option.Option<TangledRepository>>;
    /** The owner and collaborators, who may merge; cached. */
    readonly listMaintainers: (
      repository: TangledRepository,
    ) => Effect.Effect<ReadonlySet<string>, TangledApiError>;
    readonly listPulls: (input: {
      readonly repoDid: string;
      readonly state?: TicketState;
      readonly limit: number;
      readonly cursor?: string | null;
    }) => Effect.Effect<TangledPage<TangledTicket>, TangledApiError>;
    /** Cached for seconds, so the reads of one pull request share it. */
    readonly getTicket: (input: {
      readonly repoDid: string;
      readonly rkey: string;
    }) => Effect.Effect<TangledTicket & { readonly authorHandle: string }, TangledApiError>;
    /** Oldest first; cached briefly, since a new round can arrive at any time. */
    readonly listRounds: (
      ticketUri: string,
    ) => Effect.Effect<ReadonlyArray<TangledRound>, TangledApiError>;
    /**
     * Drops the cached ticket and rounds of one ticket, or of every ticket under a repository's
     * `at://<repoDid>`; all of them without one.
     */
    readonly forgetReads: (uri?: string) => Effect.Effect<void>;
    /** Newest first, as Tangled lists them. */
    readonly listComments: (
      subjectUri: string,
    ) => Effect.Effect<ReadonlyArray<TangledComment>, TangledApiError>;
    /** When the newest comment was left, from a one-comment page; null without any. */
    readonly latestCommentAt: (subjectUri: string) => Effect.Effect<string | null, TangledApiError>;
    /** Null when the ref does not exist. */
    readonly getRef: (input: {
      readonly repoDid: string;
      readonly ref: string;
    }) => Effect.Effect<string | null, TangledApiError>;
    readonly getMergeBase: (input: {
      readonly repoDids: ReadonlyArray<string>;
      readonly base: string;
      readonly head: string;
    }) => Effect.Effect<string, TangledApiError>;
    readonly listCommits: (input: {
      readonly repoDids: ReadonlyArray<string>;
      readonly range: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<TangledCommit>, TangledApiError>;
    /** Null when the blob is larger than T3 reads. */
    readonly getBlob: (input: {
      readonly repoDid: string;
      readonly commit: string;
      readonly path: string;
    }) => Effect.Effect<string | null, TangledApiError>;
    /** Cached briefly; commits never change, so neither does their diff. */
    readonly getDiff: (input: {
      readonly baseRepoDid: string;
      readonly baseCommit: string;
      readonly headRepoDid: string;
      readonly headCommit: string;
    }) => Effect.Effect<ReadonlyArray<TangledFileDiff>, TangledApiError>;
    /**
     * What changed from one round to a later one: `from` rebased onto `to`'s base, against `to`'s
     * head, so commits the target gained in between do not show. Cached briefly.
     */
    readonly getInterdiff: (input: {
      readonly from: RoundRange;
      readonly to: RoundRange;
    }) => Effect.Effect<ReadonlyArray<TangledFileDiff>, TangledApiError>;
    readonly mergeCheck: (input: {
      readonly targetRepoDid: string;
      readonly targetCommit: string;
      readonly sourceRepoDid: string;
      readonly sourceCommit: string;
    }) => Effect.Effect<
      { readonly isConflicted: boolean; readonly conflicts: ReadonlyArray<string> },
      TangledApiError
    >;
    /** Empty for a repository whose spindle is not a `did:web`. */
    readonly queryPipelines: (input: {
      readonly repository: TangledRepository;
      readonly commits: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<TangledPipeline>, TangledApiError>;
    /** The knot's copy, authoritative where bobbin's index may lag. */
    readonly getRecord: (input: {
      readonly repository: TangledRepository;
      readonly collection: string;
      readonly rkey: string;
    }) => Effect.Effect<
      { readonly uri: string; readonly cid: string; readonly value: Record<string, unknown> },
      TangledApiError
    >;
    /** Asks `knot` to host a new repository and mint its DID; the owner still has to claim it. */
    readonly createRepo: (input: {
      readonly knot: string;
      readonly name: string;
      readonly createdAt: string;
    }) => Effect.Effect<string, TangledError>;
    readonly deleteRepo: (input: {
      readonly knot: string;
      readonly repoDid: string;
    }) => Effect.Effect<void, TangledError>;
    /** The record a write answered with, or null when it answered with none. */
    readonly write: (
      input: TangledWrite,
    ) => Effect.Effect<{ readonly uri: string; readonly cid: string } | null, TangledError>;
  }
>()("@t3tools/source-control-tangled/server/TangledApi") {}

const reasonForStatus = (status: number, error: string | undefined): TangledApiError["reason"] =>
  status === 401 || status === 403 || error === "AuthRequired"
    ? "unauthenticated"
    : status === 429
      ? "rate-limited"
      : status === 404 || error === "RecordNotFound" || error === "RepoNotFound"
        ? "not-found"
        : status === 409 || error === "InvalidSwap"
          ? "conflict"
          : "failed";

type QueryParams = Record<string, string | number | ReadonlyArray<string> | null | undefined>;

const query = (params: QueryParams) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    for (const item of typeof value === "object" ? value : [value])
      search.append(key, String(item));
  }
  return search.toString();
};

const decodeProblem = Schema.decodeUnknownOption(Schema.fromJsonString(XrpcProblem));
const decodeReceipt = Schema.decodeOption(Schema.fromJsonString(Receipt));
const decodeCreatedRepo = Schema.decodeOption(Schema.fromJsonString(CreatedRepo));
const decodeTicketItem = Schema.decodeUnknownOption(TicketItem);

const toTicket = (
  record: {
    readonly uri: string;
    readonly cid: string;
    readonly authorDid: string;
    readonly state: string;
    readonly stateUpdatedAt?: string | null | undefined;
    readonly commentCount?: number | undefined;
  },
  fields: typeof TicketFields.Type,
): TangledTicket => ({
  uri: record.uri,
  cid: record.cid,
  rkey: rkeyOf(record.uri),
  authorDid: record.authorDid,
  title: fields.title.text,
  body: fields.body?.text ?? "",
  state: ticketState(record.state),
  stateUpdatedAt: record.stateUpdatedAt ?? null,
  targetBranch: fields.targetBranch ?? "",
  createdAt: fields.createdAt,
  commentCount: record.commentCount ?? 0,
});

const toComment = (comment: typeof Comment.Type): TangledComment => ({
  uri: comment.uri,
  cid: comment.cid,
  authorDid: comment.editor,
  body: comment.body?.text ?? "",
  createdAt: comment.createdAt,
  replyTo: comment.replyTo?.uri ?? null,
});

/** Lookups whose failures are not kept, so the next read asks again. */
const cached = <K, A, E>(
  lookup: (key: K) => Effect.Effect<A, E>,
  timeToLive: Duration.Input,
  capacity = CACHE_CAPACITY,
) =>
  Cache.makeWith(lookup, {
    capacity,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? timeToLive : Duration.zero),
  });

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const auth = yield* TangledAuth;
  const guardHost = yield* PublicHostGuard;

  const send = Effect.fn("TangledApi.send")(function* (input: {
    readonly operation: string;
    readonly url: string;
    readonly method?: "GET" | "POST";
    readonly token?: string;
    readonly body?: unknown;
  }) {
    const fail = (fields: {
      status: number | null;
      reason: TangledApiError["reason"];
      detail: string;
      error?: string;
      cause?: unknown;
    }) =>
      new TangledApiError({
        operation: input.operation,
        status: fields.status,
        reason: fields.reason,
        detail: fields.detail,
        ...(fields.error === undefined ? {} : { error: fields.error }),
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
      });
    yield* Effect.annotateCurrentSpan({ "tangled.operation": input.operation });
    // Knots and spindles are named by records anyone can write, so neither reads nor tokens go to
    // a private address.
    const host = new URL(input.url).hostname;
    if (host !== BOBBIN_HOST)
      yield* guardHost(host).pipe(
        Effect.mapError((cause) =>
          fail({ status: null, reason: "failed", detail: cause.message, cause }),
        ),
      );
    let request = HttpClientRequest.make(input.method ?? "GET")(input.url).pipe(
      HttpClientRequest.setHeaders({ "user-agent": "t3code" }),
    );
    if (input.token !== undefined) request = HttpClientRequest.bearerToken(request, input.token);
    if (input.body !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, input.body);
    const response = yield* httpClient.execute(request).pipe(
      // Query strings carry branch names and DIDs.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      // fetch would carry a bearer token to any redirect target.
      input.token === undefined
        ? (effect) => effect
        : Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
      Effect.flatMap((response) =>
        response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
      ),
      Effect.timeout(TIMEOUT),
      Effect.mapError((cause) =>
        fail({ status: null, reason: "failed", detail: "Could not reach Tangled.", cause }),
      ),
    );
    if (response.status >= 200 && response.status < 300) return response.text;
    const problem = Option.getOrUndefined(decodeProblem(response.text));
    return yield* fail({
      status: response.status,
      reason: reasonForStatus(response.status, problem?.error),
      detail:
        problem?.message?.trim().slice(0, 300) ||
        problem?.error ||
        `Tangled answered HTTP ${response.status}.`,
      ...(problem?.error === undefined ? {} : { error: problem.error }),
    });
  });

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    nsid: string,
    params: QueryParams,
    schema: S,
    service = BOBBIN,
  ) =>
    send({ operation: nsid, url: `${service}/xrpc/${nsid}?${query(params)}` }).pipe(
      Effect.flatMap((text) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
          Effect.mapError(
            (cause) =>
              new TangledApiError({
                operation: nsid,
                status: null,
                reason: "failed",
                detail: "Tangled returned an unreadable response.",
                cause,
              }),
          ),
        ),
      ),
    );

  /** Every item of a paged listing, up to `MAX_LISTED`. */
  const readAll = <S extends Schema.Codec<unknown, unknown, never, never>>(
    nsid: string,
    params: QueryParams,
    item: S,
  ) => {
    const Page = Schema.Struct({ items: Schema.Array(item), cursor: Cursor });
    return Effect.gen(function* () {
      const collected: Array<S["Type"]> = [];
      let cursor: string | null = null;
      do {
        const page: typeof Page.Type = yield* read(
          nsid,
          { ...params, limit: PAGE_SIZE, cursor },
          Page,
        );
        collected.push(...page.items);
        cursor = page.items.length === 0 ? null : (page.cursor ?? null);
      } while (cursor !== null && collected.length < MAX_LISTED);
      return collected;
    });
  };

  const identities = yield* cached(
    (identifier: string) =>
      read(NSID.resolveIdentity, { identifier }, MiniDoc).pipe(
        Effect.map((identity) => ({
          did: identity.did,
          // atproto's placeholder for a handle that no longer verifies.
          handle: identity.handle === "handle.invalid" ? null : identity.handle,
        })),
      ),
    IDENTITY_TTL,
  );
  const resolveIdentity = (identifier: string) => Cache.get(identities, identifier.toLowerCase());

  const toRepository = Effect.fn("TangledApi.toRepository")(function* (
    manifest: typeof Manifest.Type,
  ) {
    const repoDid = repoDidOfUri(manifest.uri);
    const owner = yield* resolveIdentity(manifest.value.declaration.owner).pipe(
      Effect.orElseSucceed(() => ({ did: manifest.value.declaration.owner, handle: null })),
    );
    if (!isDid(repoDid) || !manifest.knot)
      return yield* new TangledApiError({
        operation: NSID.getRepoByRepoDid,
        status: null,
        reason: "failed",
        detail: "Tangled did not name the repository's DID and knot.",
      });
    return {
      repoDid,
      ownerDid: owner.did,
      ownerHandle: owner.handle,
      name: manifest.value.declaration.name,
      knot: manifest.knot,
      defaultBranch: manifest.defaultBranch ?? null,
      spindle: manifest.value.spindle ?? null,
    } satisfies TangledRepository;
  });

  // Keyed by the reference itself; names are case-insensitive, so a named one is lowercased.
  const normalize = (reference: TangledRepositoryRef): TangledRepositoryRef =>
    reference.kind === "repo-did"
      ? { kind: "repo-did", repoDid: reference.repoDid }
      : { kind: "named", owner: reference.owner.toLowerCase(), name: reference.name.toLowerCase() };

  const repositories: Cache.Cache<TangledRepositoryRef, TangledRepository, TangledApiError> =
    yield* cached(
      (reference: TangledRepositoryRef) =>
        reference.kind === "repo-did"
          ? read(NSID.getRepoByRepoDid, { repoDid: reference.repoDid }, Manifest).pipe(
              Effect.flatMap(toRepository),
            )
          : resolveIdentity(reference.owner).pipe(
              Effect.flatMap((owner) =>
                read(NSID.getRepoByName, { owner: owner.did, name: reference.name }, Manifest),
              ),
              Effect.flatMap(toRepository),
              Effect.tap((repository) =>
                Cache.set(
                  repositories,
                  { kind: "repo-did", repoDid: repository.repoDid },
                  repository,
                ),
              ),
            ),
      REPOSITORY_TTL,
    );

  const maintainers = yield* cached(
    (repository: { readonly repoDid: string; readonly ownerDid: string }) =>
      read(
        NSID.listCollaborators,
        { subject: repository.repoDid, limit: MAX_LISTED },
        Collaborators,
      ).pipe(
        Effect.map(
          (page): ReadonlySet<string> =>
            new Set([repository.ownerDid, ...page.items.map((item) => item.subject)]),
        ),
      ),
    REPOSITORY_TTL,
  );

  const tickets = yield* cached(
    (uri: string) =>
      read(NSID.getTicketView, { uri }, TicketView).pipe(
        Effect.map((view) => ({
          ...toTicket({ ...view, authorDid: view.author.did }, view),
          authorHandle: view.author.handle,
        })),
      ),
    TICKET_TTL,
  );

  const rounds = yield* cached(
    Effect.fn("TangledApi.readRounds")(function* (uri: string) {
      const repoDid = repoDidOfUri(uri);
      const patches = yield* readAll(NSID.listPatches, { ticket: uri, order: "asc" }, Patch);
      return patches.map((patch, index): TangledRound => ({
        round: index + 1,
        uri: patch.uri,
        cid: patch.cid,
        baseOid: patch.value.base.oid,
        headOid: patch.value.head.oid,
        sourceRepoDid: patch.value.source?.repo || repoDid,
        sourceBranch: patch.value.source?.branch ?? null,
        createdAt: patch.value.createdAt,
      }));
    }),
    ROUNDS_TTL,
  );

  const diffs = yield* cached(
    (params: Readonly<Record<string, string>>) =>
      read(NSID.getDiff, params, Diffs).pipe(Effect.map((result) => result.diffs)),
    DIFF_TTL,
    DIFF_CAPACITY,
  );
  const interdiffs = yield* cached(
    (params: Readonly<Record<string, string>>) =>
      read(NSID.getInterdiff, params, Diffs).pipe(Effect.map((result) => result.diffs)),
    DIFF_TTL,
    DIFF_CAPACITY,
  );

  const authorizedCall = Effect.fn("TangledApi.authorizedCall")(function* (input: TangledWrite) {
    // Record writes and patches are the repository's own; merges push to its knot.
    const target =
      input.service === "knot-host"
        ? { aud: serviceDid(input.knot), lxm: input.nsid, base: `https://${input.knot}` }
        : input.service === "bobbin"
          ? {
              aud: serviceDid(input.repository.knot),
              lxm: NSID.receivePack,
              base: BOBBIN,
            }
          : {
              aud: input.repository.repoDid,
              lxm: input.nsid,
              base: `https://${input.repository.knot}`,
            };
    const token = yield* auth.serviceAuth({ aud: target.aud, lxm: target.lxm });
    const text = yield* send({
      operation: input.nsid,
      url: `${target.base}/xrpc/${input.nsid}`,
      method: "POST",
      token,
      body:
        input.service === "knot" ? { repo: input.repository.repoDid, ...input.body } : input.body,
    });
    return { text, receipt: Option.getOrNull(decodeReceipt(text)) };
  });

  const forgetIn = Effect.fn("TangledApi.forgetIn")(function* <A, E>(
    cache: Cache.Cache<string, A, E>,
    uri: string | undefined,
  ) {
    if (uri === undefined) return yield* Cache.invalidateAll(cache);
    for (const key of Array.from(yield* Cache.keys(cache)))
      if (key === uri || key.startsWith(`${uri}/`)) yield* Cache.invalidate(cache, key);
  });

  return TangledApi.of({
    resolveIdentity,
    createRepo: Effect.fn("TangledApi.createRepo")(function* (input) {
      const { text } = yield* authorizedCall({
        service: "knot-host",
        knot: input.knot,
        nsid: NSID.createRepo,
        body: { name: input.name, createdAt: input.createdAt },
      });
      const created = Option.filter(decodeCreatedRepo(text), (repo) => isDid(repo.did));
      if (Option.isNone(created))
        return yield* new TangledApiError({
          operation: NSID.createRepo,
          status: null,
          reason: "failed",
          detail: `${input.knot} did not name the new repository's DID.`,
        });
      return created.value.did;
    }),
    deleteRepo: Effect.fn("TangledApi.deleteRepo")(function* (input) {
      yield* authorizedCall({
        service: "knot-host",
        knot: input.knot,
        nsid: NSID.deleteRepo,
        body: { repo: input.repoDid },
      });
    }),
    listMaintainers: Effect.fn("TangledApi.listMaintainers")((repository) =>
      Cache.get(maintainers, { repoDid: repository.repoDid, ownerDid: repository.ownerDid }),
    ),
    resolveRepository: Effect.fn("TangledApi.resolveRepository")((reference) =>
      Cache.get(repositories, normalize(reference)),
    ),
    cachedRepository: Effect.fn("TangledApi.cachedRepository")((reference) =>
      Cache.getSuccess(repositories, normalize(reference)),
    ),
    listPulls: Effect.fn("TangledApi.listPulls")(function* (input) {
      const page = yield* read(
        NSID.listPulls,
        { subject: input.repoDid, status: input.state, limit: input.limit, cursor: input.cursor },
        // Rows are decoded one at a time, so one that is not a ticket is skipped.
        Schema.Struct({ items: Schema.Array(Schema.Unknown), cursor: Cursor }),
      );
      return {
        items: page.items.flatMap((raw) =>
          Option.toArray(decodeTicketItem(raw)).map((item) =>
            toTicket({ ...item, authorDid: item.author }, item.value),
          ),
        ),
        cursor: page.items.length === 0 ? null : (page.cursor ?? null),
      };
    }),
    getTicket: Effect.fn("TangledApi.getTicket")((input) =>
      Cache.get(tickets, ticketUri(input.repoDid, input.rkey)),
    ),
    listRounds: Effect.fn("TangledApi.listRounds")((uri) => Cache.get(rounds, uri)),
    forgetReads: Effect.fn("TangledApi.forgetReads")(function* (uri) {
      yield* forgetIn(rounds, uri);
      yield* forgetIn(tickets, uri);
    }),
    listComments: Effect.fn("TangledApi.listComments")((subjectUri) =>
      readAll(NSID.listComments, { subject: subjectUri }, Comment).pipe(
        Effect.map((comments) => comments.map(toComment)),
      ),
    ),
    latestCommentAt: Effect.fn("TangledApi.latestCommentAt")((subjectUri) =>
      read(
        NSID.listComments,
        { subject: subjectUri, limit: 1 },
        Schema.Struct({ items: Schema.Array(Comment) }),
      ).pipe(Effect.map((page) => page.items[0]?.createdAt ?? null)),
    ),
    getRef: Effect.fn("TangledApi.getRef")((input) =>
      read(NSID.getRef, { repo: input.repoDid, ref: input.ref }, Ref).pipe(
        Effect.map((ref): string | null => ref.oid),
        Effect.catchIf(
          (error) => error.reason === "not-found",
          () => Effect.succeed(null),
        ),
      ),
    ),
    getMergeBase: Effect.fn("TangledApi.getMergeBase")((input) =>
      read(
        NSID.getMergeBase,
        { repos: input.repoDids, base: input.base, head: input.head },
        MergeBase,
      ).pipe(Effect.map((result) => result.commit)),
    ),
    listCommits: Effect.fn("TangledApi.listCommits")((input) =>
      read(
        NSID.listCommits,
        { repos: input.repoDids, ranges: [input.range], limit: input.limit },
        Commits,
      ).pipe(Effect.map((result) => result.commits)),
    ),
    getBlob: Effect.fn("TangledApi.getBlob")((input) =>
      send({
        operation: NSID.getBlob,
        url: `${BOBBIN}/xrpc/${NSID.getBlob}?${query({ repo: input.repoDid, ref: input.commit, path: input.path })}`,
      }).pipe(Effect.map((text) => (text.length > MAX_BLOB_BYTES ? null : text))),
    ),
    getDiff: Effect.fn("TangledApi.getDiff")((input) =>
      Cache.get(diffs, {
        baseRepo: input.baseRepoDid,
        baseCommit: input.baseCommit,
        headRepo: input.headRepoDid,
        headCommit: input.headCommit,
      }),
    ),
    getInterdiff: Effect.fn("TangledApi.getInterdiff")((input) =>
      // Named for the two rounds, not two sides: `base*` is the earlier round's range.
      Cache.get(interdiffs, {
        baseRepo: input.from.sourceRepoDid,
        baseCommit1: input.from.baseOid,
        baseCommit2: input.from.headOid,
        headRepo: input.to.sourceRepoDid,
        headCommit1: input.to.baseOid,
        headCommit2: input.to.headOid,
      }),
    ),
    mergeCheck: Effect.fn("TangledApi.mergeCheck")((input) =>
      read(
        NSID.mergeCheck,
        {
          targetRepo: input.targetRepoDid,
          targetCommit: input.targetCommit,
          sourceRepo: input.sourceRepoDid,
          sourceCommit: input.sourceCommit,
        },
        MergeCheck,
      ).pipe(
        Effect.map((result) => ({
          isConflicted: result.isConflicted,
          conflicts: result.conflicts.map((conflict) => conflict.filename),
        })),
      ),
    ),
    queryPipelines: Effect.fn("TangledApi.queryPipelines")((input) => {
      const host = input.repository.spindle ? hostOfServiceDid(input.repository.spindle) : null;
      return host === null || input.commits.length === 0
        ? Effect.succeed([])
        : read(
            NSID.queryPipelines,
            { repo: input.repository.repoDid, commits: input.commits, limit: 50 },
            Pipelines,
            `https://${host}`,
          ).pipe(Effect.map((result) => result.pipelines));
    }),
    getRecord: Effect.fn("TangledApi.getRecord")((input) =>
      read(
        NSID.getRecord,
        { repo: input.repository.repoDid, collection: input.collection, rkey: input.rkey },
        RecordView,
        `https://${input.repository.knot}`,
      ),
    ),
    write: Effect.fn("TangledApi.write")((input) =>
      authorizedCall(input).pipe(
        Effect.map(({ text, receipt }) => (text.trim().length === 0 ? null : receipt)),
      ),
    ),
  });
});

export const layer = Layer.effect(TangledApi, make);

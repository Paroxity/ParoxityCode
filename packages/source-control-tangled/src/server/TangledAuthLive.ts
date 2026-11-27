import {
  SourceControlProviderKind,
  SourceControlSignInError,
  type SourceControlSignInFailure,
  type SourceControlSignInPrompt,
} from "@t3tools/contracts";
import type { SourceControlSignIn } from "@t3tools/source-control-core/server/driver";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  appSignInSettingsFields,
  readSourceControlHostSettings,
} from "@t3tools/source-control-core/shared/definition";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { isDid } from "../shared/definition.ts";
import { PublicHostGuard } from "./publicHost.ts";
import { BOBBIN, MiniDoc, NSID } from "./TangledApi.ts";
import { TangledAuth, TangledAuthError, type TangledViewer } from "./TangledAuth.ts";
import * as TangledOAuth from "./TangledOAuth.ts";

/** The relay in `infra/tangled-oauth`: client metadata and the callback the server polls for. */
const DEFAULT_RELAY_ORIGIN = "https://t3-oauth.kaeden.codes";
/** Points the server at another relay, as one deployed to test the relay itself. */
const RELAY_ORIGIN_ENV = "T3CODE_TANGLED_OAUTH_RELAY_URL";

const KIND = SourceControlProviderKind.make("tangled");
const HOST = "tangled.org";
// The relay keeps a callback 15 minutes; give up before it does.
const SIGN_IN_LIFETIME = Duration.minutes(10);
const POLL_INTERVAL = Duration.seconds(2);
const REQUEST_TIMEOUT = Duration.seconds(15);
const HANDLE_TTL = Duration.hours(1);
/** Refreshes this long before the access token lapses, so a call does not race its expiry. */
const REFRESH_MARGIN = Duration.toMillis(Duration.minutes(1));

const SignInSettings = Schema.Struct(appSignInSettingsFields);
const SessionJson = Schema.fromJsonString(TangledOAuth.Session);
// A session `@atproto/oauth-client-node` saved is bound to the old confidential client, so it
// reads as no session and the viewer signs in again.
const decodeSession = Schema.decodeUnknownOption(SessionJson);
const encodeSession = Schema.encodeSync(SessionJson);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const signInError = (
  host: string,
  reason: SourceControlSignInFailure,
  detail: string,
  cause?: unknown,
) =>
  new SourceControlSignInError({
    provider: KIND,
    host,
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const expired = (cause?: unknown) =>
  new TangledAuthError({
    reason: "expired",
    detail: "The Tangled sign-in expired. Sign in again in Settings → Source Control.",
    ...(cause === undefined ? {} : { cause }),
  });

class CallbackPending extends Schema.TaggedError<CallbackPending>()("CallbackPending", {}) {}

interface PendingSignIn {
  readonly deferred: Deferred.Deferred<{ readonly account: string }, SourceControlSignInError>;
  readonly fiber: Fiber.Fiber<unknown, unknown>;
}

/** @public */
export const make = Effect.fn("TangledAuth.make")(function* (options: {
  readonly relayOrigin: string;
}) {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const http = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  const pending = yield* Ref.make<ReadonlyMap<string, PendingSignIn>>(new Map());
  const refreshing = yield* Semaphore.make(1);
  const oauth = TangledOAuth.makeClient(http, yield* PublicHostGuard);
  const relay = options.relayOrigin.replace(/\/+$/u, "");
  const clientId = `${relay}/tangled/client-metadata.json`;
  const redirectUri = `${relay}/tangled/callback`;

  const stored = sourceControlHost.settings.get.pipe(
    Effect.map((settings) => {
      const { signIns } = readSourceControlHostSettings(
        SignInSettings,
        settings.sourceControlHosts[KIND],
      );
      return { signIns, session: decodeSession(signIns[HOST] ?? "") };
    }),
    Effect.orElseSucceed(() => ({
      signIns: {} as Readonly<Record<string, string>>,
      session: Option.none<TangledOAuth.Session>(),
    })),
  );

  /** A sign-in stores any account; a refresh rewrites only the session it refreshed. */
  const writeSession = Effect.fn("TangledAuth.writeSession")(
    function* (
      next: TangledOAuth.Session | null,
      when: (current: Option.Option<TangledOAuth.Session>) => boolean,
    ) {
      const { signIns, session } = yield* stored;
      if (!when(session)) return;
      const updated = { ...signIns };
      if (next === null) delete updated[HOST];
      else updated[HOST] = encodeSession(next);
      yield* sourceControlHost.settings.update({
        sourceControlHosts: { [KIND]: { signIns: updated } },
      });
    },
    Effect.mapError(
      (cause) =>
        new TangledAuthError({
          reason: "failed",
          detail: "The server could not save the Tangled sign-in.",
          cause,
        }),
    ),
  );

  const resolveMiniDoc = (identifier: string) =>
    http
      .execute(
        HttpClientRequest.get(`${BOBBIN}/xrpc/${NSID.resolveIdentity}`).pipe(
          HttpClientRequest.setUrlParam("identifier", identifier),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(MiniDoc)),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(
          (cause) =>
            new TangledOAuth.OAuthError({ detail: `Could not resolve ${identifier}.`, cause }),
        ),
      );

  const handles = yield* Cache.makeWith(
    (did: string) =>
      resolveMiniDoc(did).pipe(
        // atproto's placeholder for a handle that no longer verifies.
        Effect.map((doc) => (doc.handle === "handle.invalid" ? null : doc.handle)),
      ),
    {
      capacity: 8,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? HANDLE_TTL : Duration.zero),
    },
  );

  // Tangled routes accept a DID where a handle would go, so it stands in for one that fails.
  const handleOf = (did: string) =>
    Cache.get(handles, did).pipe(
      Effect.map((handle) => handle ?? did),
      Effect.catch((cause) =>
        Effect.logWarning("Could not resolve the Tangled account's handle.", {
          did,
          cause,
        }).pipe(Effect.as(did)),
      ),
    );

  const viewer: TangledAuth["Service"]["viewer"] = Effect.gen(function* () {
    const { session } = yield* stored;
    if (Option.isNone(session)) return Option.none<TangledViewer>();
    return Option.some({ did: session.value.did, handle: yield* handleOf(session.value.did) });
  }).pipe(Effect.withSpan("TangledAuth.viewer"));

  /**
   * The stored session with an access token worth sending: refreshed when it is about to lapse,
   * or when the PDS refused `stale`. Refreshes run one at a time, since a refresh token works once.
   */
  const usableSession = (stale: string | null) =>
    refreshing.withPermits(1)(
      Effect.gen(function* () {
        const current = (yield* stored).session;
        if (Option.isNone(current))
          return yield* new TangledAuthError({
            reason: "not-signed-in",
            detail: "Sign in to Tangled in Settings → Source Control.",
          });
        const session = current.value;
        const now = yield* Clock.currentTimeMillis;
        if (
          stale === null ? session.expiresAt - REFRESH_MARGIN > now : session.accessToken !== stale
        )
          return session;
        const stillStored = (found: Option.Option<TangledOAuth.Session>) =>
          Option.isSome(found) &&
          found.value.did === session.did &&
          found.value.refreshToken === session.refreshToken;
        const tokens = yield* oauth.refresh(session, clientId).pipe(
          Effect.catchTags({
            OAuthError: (error) =>
              error.error === "invalid_grant"
                ? writeSession(null, stillStored).pipe(Effect.andThen(Effect.fail(expired(error))))
                : Effect.fail(
                    new TangledAuthError({
                      reason: "failed",
                      detail: `Could not refresh the Tangled sign-in: ${error.detail}`,
                      cause: error,
                    }),
                  ),
          }),
        );
        const next = yield* TangledOAuth.sessionOf({
          tokens,
          server: { issuer: session.issuer, token_endpoint: session.tokenEndpoint },
          pds: session.pds,
          key: session.dpopKey,
          previous: session,
        });
        yield* writeSession(next, stillStored);
        return next;
      }),
    );

  /** An XRPC call to the viewer's PDS as the viewer; a refused session fails as expired. */
  const pdsCall = Effect.fn("TangledAuth.pdsCall")(function* (
    nsid: string,
    request: { readonly query?: Record<string, string>; readonly body?: unknown },
  ) {
    const send = (session: TangledOAuth.Session) => {
      const url = `${session.pds.replace(/\/+$/u, "")}/xrpc/${nsid}`;
      return oauth
        .resource(
          session,
          request.body === undefined
            ? HttpClientRequest.get(url).pipe(HttpClientRequest.setUrlParams(request.query ?? {}))
            : HttpClientRequest.post(url).pipe(
                HttpClientRequest.bodyText(encodeJson(request.body), "application/json"),
              ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new TangledAuthError({
                reason: "failed",
                detail: `Could not reach your PDS: ${cause.detail}`,
                cause,
              }),
          ),
        );
    };
    const session = yield* usableSession(null);
    let reply = yield* send(session);
    // The PDS may have revoked the token early; one refresh decides whether the session still holds.
    if (reply.response.status === 401)
      reply = yield* send(yield* usableSession(session.accessToken));
    if (reply.response.status === 401) return yield* expired();
    const fields =
      typeof reply.body === "object" && reply.body !== null
        ? (reply.body as Record<string, unknown>)
        : {};
    return {
      did: session.did,
      status: reply.response.status,
      ok: reply.response.status >= 200 && reply.response.status < 300,
      fields,
    };
  });

  const refusal = (
    what: string,
    reply: { readonly status: number; readonly fields: Record<string, unknown> },
  ) => {
    const reason =
      typeof reply.fields.message === "string" ? reply.fields.message : reply.fields.error;
    return new TangledAuthError({
      reason: "failed",
      detail: `Your PDS would not ${what} (${reply.status}${
        typeof reason === "string" ? `: ${reason}` : ""
      }).`,
    });
  };

  const recordRef = (fields: Record<string, unknown>) =>
    typeof fields.uri === "string" && typeof fields.cid === "string"
      ? Option.some({ uri: fields.uri, cid: fields.cid })
      : Option.none();

  const viewerDid = stored.pipe(
    Effect.map(({ session }) => Option.match(session, { onNone: () => "", onSome: (s) => s.did })),
  );

  const serviceAuth: TangledAuth["Service"]["serviceAuth"] = Effect.fn("TangledAuth.serviceAuth")(
    function* ({ aud, lxm }) {
      const reply = yield* pdsCall("com.atproto.server.getServiceAuth", { query: { aud, lxm } });
      if (!reply.ok || typeof reply.fields.token !== "string")
        return yield* refusal(`authorize ${lxm}`, reply);
      return reply.fields.token;
    },
  );

  const getRecord: TangledAuth["Service"]["getRecord"] = Effect.fn("TangledAuth.getRecord")(
    function* ({ collection, rkey }) {
      const reply = yield* pdsCall("com.atproto.repo.getRecord", {
        query: { repo: yield* viewerDid, collection, rkey },
      });
      if (reply.fields.error === "RecordNotFound") return Option.none();
      if (!reply.ok) return yield* refusal(`read ${collection}/${rkey}`, reply);
      return recordRef(reply.fields);
    },
  );

  const createRecord: TangledAuth["Service"]["createRecord"] = Effect.fn(
    "TangledAuth.createRecord",
  )(function* ({ collection, rkey, record }) {
    const reply = yield* pdsCall("com.atproto.repo.createRecord", {
      body: { repo: yield* viewerDid, collection, rkey, record },
    });
    const written = reply.ok ? recordRef(reply.fields) : Option.none();
    if (Option.isNone(written)) return yield* refusal(`write ${collection}/${rkey}`, reply);
    return written.value;
  });

  /** Files `state` with the relay, which then hands its callback only to this poll token. */
  const registerState = (state: string) =>
    http
      .execute(
        HttpClientRequest.post(`${relay}/tangled/start`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ state }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(
          HttpClientResponse.schemaBodyJson(Schema.Struct({ pollToken: Schema.String })),
        ),
        Effect.map(({ pollToken }) => pollToken),
        Effect.timeout(REQUEST_TIMEOUT),
      );

  const relayCallback = (state: string, pollToken: string) =>
    http
      .execute(
        HttpClientRequest.get(`${relay}/tangled/callback/${state}`).pipe(
          HttpClientRequest.bearerToken(pollToken),
        ),
      )
      .pipe(
        Effect.filterOrFail(
          (response) => response.status === 200,
          () => new CallbackPending(),
        ),
        Effect.flatMap((response) => response.text),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.map((query) => new URLSearchParams(query)),
      );

  /** Where `did`'s PDS is, once its authorization server is confirmed to be `issuer`. */
  const confirmAccount = Effect.fn("TangledAuth.confirmAccount")(function* (
    did: string,
    issuer: string,
  ) {
    const doc = yield* resolveMiniDoc(did);
    if (doc.did !== did || doc.pds === undefined)
      return yield* new TangledOAuth.OAuthError({ detail: `${did} names no PDS.` });
    const server = yield* oauth.discover(doc.pds);
    if (server.issuer !== issuer)
      return yield* new TangledOAuth.OAuthError({
        detail: `${did} is not hosted by ${new URL(issuer).host}.`,
      });
    return doc.pds;
  });

  const finish = Effect.fn("TangledAuth.finish")(function* (attempt: {
    readonly server: TangledOAuth.ServerMetadata;
    readonly account: { readonly did: string; readonly pds: string } | null;
    readonly key: TangledOAuth.DpopJwk;
    readonly state: string;
    readonly verifier: string;
    readonly pollToken: string;
    readonly expiresAt: number;
  }) {
    const now = yield* Clock.currentTimeMillis;
    // Pending, a dropped poll and a relay hiccup all wait for the next tick.
    const params = yield* relayCallback(attempt.state, attempt.pollToken).pipe(
      Effect.retry(
        Schedule.spaced(POLL_INTERVAL).pipe(
          Schedule.upTo({ duration: Duration.millis(Math.max(0, attempt.expiresAt - now)) }),
        ),
      ),
      Effect.mapError(() => signInError(HOST, "expired", "The sign-in expired. Start again.")),
    );
    const failed = (detail: string, cause?: unknown) => signInError(HOST, "failed", detail, cause);
    if (params.get("state") !== attempt.state)
      return yield* failed("The sign-in answered for another attempt. Start again.");
    const error = params.get("error");
    if (error === "access_denied")
      return yield* signInError(HOST, "denied", "The sign-in was declined.");
    // RFC 9207: the issuer named in the callback must be the server the sign-in started at.
    if (params.get("iss") !== attempt.server.issuer)
      return yield* failed("The sign-in came back from another server. Start again.");
    const code = params.get("code");
    if (error !== null || code === null)
      return yield* failed(
        `Your PDS refused the sign-in: ${params.get("error_description") ?? error ?? "no code"}`,
      );
    const session = yield* Effect.gen(function* () {
      const tokens = yield* oauth.exchangeCode({
        server: attempt.server,
        key: attempt.key,
        clientId,
        redirectUri,
        code,
        verifier: attempt.verifier,
      });
      if (attempt.account !== null && tokens.sub !== attempt.account.did)
        return yield* new TangledOAuth.OAuthError({
          detail: "Your PDS signed in a different account than the one asked for.",
        });
      const pds =
        attempt.account?.pds ?? (yield* confirmAccount(tokens.sub, attempt.server.issuer));
      return yield* TangledOAuth.sessionOf({
        tokens,
        server: attempt.server,
        pds,
        key: attempt.key,
      });
    }).pipe(
      Effect.mapError((cause) => failed(`Your PDS refused the sign-in: ${cause.detail}`, cause)),
    );
    yield* writeSession(session, () => true).pipe(
      Effect.mapError((cause) => failed(cause.detail, cause)),
    );
    yield* Cache.invalidate(handles, session.did);
    return { account: yield* handleOf(session.did) };
  });

  const start: SourceControlSignIn["start"] = Effect.fn("TangledAuth.signIn.start")(
    function* (rawHost, rawAccount) {
      const host = rawHost.trim().toLowerCase();
      if (host !== HOST) {
        return yield* signInError(host, "unsupported", `Tangled signs in only on ${HOST}.`);
      }
      const entered = rawAccount?.trim().replace(/^@/, "") ?? "";
      // Handles are case-insensitive and phone keyboards capitalize; DIDs and PDS URLs are not.
      const server = /:\/\//u.test(entered);
      const account = server || isDid(entered) ? entered : entered.toLowerCase();
      if (account === "") {
        return yield* signInError(host, "failed", "Enter your handle to sign in to Tangled.");
      }
      const target = Effect.gen(function* () {
        if (server)
          return { server: yield* oauth.discover(account), account: null, hint: undefined };
        const doc = yield* resolveMiniDoc(account);
        if (doc.pds === undefined)
          return yield* new TangledOAuth.OAuthError({ detail: `${account} names no PDS.` });
        return {
          server: yield* oauth.discover(doc.pds),
          account: { did: doc.did, pds: doc.pds },
          hint: account,
        };
      });
      const prepared = yield* Effect.gen(function* () {
        const { hint, ...found } = yield* target;
        const secrets = TangledOAuth.makeAuthorizationSecrets();
        const key = TangledOAuth.makeDpopKey();
        const pollToken = yield* registerState(secrets.state).pipe(
          Effect.mapError(
            (cause) =>
              new TangledOAuth.OAuthError({
                detail: "the server could not reach the Tangled sign-in relay.",
                cause,
              }),
          ),
        );
        const url = yield* oauth.pushAuthorization({
          server: found.server,
          key,
          clientId,
          redirectUri,
          state: secrets.state,
          challenge: secrets.challenge,
          loginHint: hint,
        });
        return { ...found, key, state: secrets.state, verifier: secrets.verifier, pollToken, url };
      }).pipe(
        Effect.mapError((cause) =>
          signInError(
            host,
            "failed",
            `Could not start signing in as ${account}: ${cause.detail}`,
            cause,
          ),
        ),
      );
      const expiresAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(SIGN_IN_LIFETIME);
      const deferred = yield* Deferred.make<
        { readonly account: string },
        SourceControlSignInError
      >();
      const fiber = yield* finish({ ...prepared, expiresAt }).pipe(
        Deferred.into(deferred),
        Effect.forkIn(scope),
      );
      const previous = yield* Ref.modify(pending, (current) => [
        current.get(host),
        new Map(current).set(host, { deferred, fiber }),
      ]);
      if (previous !== undefined) {
        yield* Deferred.fail(
          previous.deferred,
          signInError(host, "failed", "A newer sign-in replaced this one."),
        );
        yield* Fiber.interrupt(previous.fiber);
      }
      return { verificationUri: prepared.url, expiresAt } satisfies SourceControlSignInPrompt;
    },
  );

  const wait: SourceControlSignIn["wait"] = Effect.fn("TangledAuth.signIn.wait")(
    function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      const current = (yield* Ref.get(pending)).get(host);
      if (current === undefined) {
        return yield* signInError(host, "not-started", "No sign-in is in progress. Start again.");
      }
      return yield* Deferred.await(current.deferred);
    },
  );

  const cancel: SourceControlSignIn["cancel"] = Effect.fn("TangledAuth.signIn.cancel")(
    function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      const current = (yield* Ref.get(pending)).get(host);
      if (current === undefined) return;
      yield* Deferred.fail(
        current.deferred,
        signInError(host, "cancelled", "The sign-in was cancelled."),
      );
      yield* Fiber.interrupt(current.fiber);
    },
  );

  return TangledAuth.of({
    viewer,
    serviceAuth,
    getRecord,
    createRecord,
    signIn: {
      start,
      wait,
      cancel,
      // Tangled has no app to install per account, so nothing is ever "not covered".
      access: () => Effect.succeed("signed-out"),
    },
  });
});

export const layer: Layer.Layer<
  TangledAuth,
  never,
  SourceControlHost.SourceControlHost | HttpClient.HttpClient
> = Layer.effect(
  TangledAuth,
  Effect.gen(function* () {
    const relayOrigin = yield* Config.String(RELAY_ORIGIN_ENV).pipe(
      Config.withDefault(DEFAULT_RELAY_ORIGIN),
      Effect.orElseSucceed(() => DEFAULT_RELAY_ORIGIN),
    );
    return yield* make({ relayOrigin });
  }),
);

// @effect-diagnostics nodeBuiltinImport:off - verifies the DPoP proofs' signatures and PKCE with node:crypto.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import { literalHostGuard, PublicHostGuard } from "./publicHost.ts";
import { TangledAuth } from "./TangledAuth.ts";
import * as TangledAuthLive from "./TangledAuthLive.ts";
import * as TangledOAuth from "./TangledOAuth.ts";

const DID = "did:plc:aszazhqi6awopjhatmhcvqsr";
const RELAY = "https://relay.example";
const PDS = "https://pds.example";
const ISSUER = "https://auth.example";
const CLIENT_ID = `${RELAY}/tangled/client-metadata.json`;

interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly form: URLSearchParams;
  readonly json: unknown;
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Verifies a DPoP proof against the key it carries and hands back its claims. */
function proofClaims(proof: string | undefined) {
  const [header = "", payload = "", signature = ""] = (proof ?? "").split(".");
  const { jwk, typ, alg } = JSON.parse(Buffer.from(header, "base64url").toString());
  expect({ typ, alg }).toEqual({ typ: "dpop+jwt", alg: "ES256" });
  expect(jwk).not.toHaveProperty("d");
  const verified = NodeCrypto.verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: NodeCrypto.createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
  expect(verified).toBe(true);
  return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
}

const sha256 = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest().toString("base64url");

/**
 * The atproto world a sign-in walks: Tangled's identity resolver, the PDS and its authorization
 * server, each of which asks for a DPoP nonce once, and the relay holding the callback.
 */
function fakeWorld(
  options: {
    readonly pds?: string;
    /** What the token endpoint answers a refresh with. */
    readonly refresh?: "ok" | "invalid_grant";
    /** Access tokens the PDS refuses as `invalid_token`. */
    readonly revoked?: ReadonlyArray<string>;
    readonly pdsAnswer?: (seen: Seen) => Response | undefined;
  } = {},
) {
  const seen: Array<Seen> = [];
  const callbacks = new Map<string, string>();
  const pollTokens = new Map<string, string>();
  const issued = { access: 0 };
  const nonceSent = new Set<string>();
  const decoder = new TextDecoder();
  /** A DPoP nonce once per origin, as atproto servers ask for one. */
  const needsNonce = (url: URL, headers: Readonly<Record<string, string>>) => {
    if (nonceSent.has(url.origin)) return proofClaims(headers.dpop).nonce !== `nonce-${url.host}`;
    nonceSent.add(url.origin);
    return true;
  };
  const answer = (request: Seen): Response => {
    const { url, method, headers, form } = request;
    if (url.origin === "https://api.tangled.org") {
      const identifier = url.searchParams.get("identifier");
      return identifier === DID || identifier === "kaeden.codes"
        ? reply(200, { did: DID, handle: "kaeden.codes", pds: options.pds ?? PDS })
        : reply(404, { error: "NotFound" });
    }
    if (url.origin === RELAY) {
      if (method === "POST" && url.pathname === "/tangled/start") {
        const { state } = request.json as { state: string };
        pollTokens.set(state, `poll-${state}`);
        return reply(200, { pollToken: `poll-${state}` });
      }
      const state = url.pathname.split("/").pop() ?? "";
      if (headers.authorization !== `Bearer ${pollTokens.get(state)}`) return reply(401, null);
      const query = callbacks.get(state);
      callbacks.delete(state);
      return query === undefined ? reply(204, null) : new Response(query);
    }
    if (url.origin === PDS && url.pathname === "/.well-known/oauth-protected-resource")
      return reply(200, { resource: PDS, authorization_servers: [ISSUER] });
    if (url.origin === ISSUER && url.pathname === "/.well-known/oauth-authorization-server")
      return reply(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
        dpop_signing_alg_values_supported: ["ES256"],
      });
    if (url.origin === ISSUER) {
      if (needsNonce(url, headers))
        return reply(400, { error: "use_dpop_nonce" }, { "dpop-nonce": `nonce-${url.host}` });
      if (url.pathname === "/oauth/par") return reply(201, { request_uri: "urn:request:1" });
      if (form.get("grant_type") === "refresh_token" && options.refresh === "invalid_grant")
        return reply(400, { error: "invalid_grant", error_description: "Refresh token revoked" });
      issued.access += 1;
      return reply(200, {
        access_token: `access-${issued.access}`,
        token_type: "DPoP",
        refresh_token: `refresh-${issued.access}`,
        expires_in: 3600,
        scope: TangledOAuth.SCOPE,
        sub: DID,
      });
    }
    if (url.origin === PDS) {
      const token = headers.authorization?.replace(/^DPoP /u, "") ?? "";
      if (needsNonce(url, headers))
        return reply(
          401,
          { error: "use_dpop_nonce" },
          {
            "dpop-nonce": `nonce-${url.host}`,
            "www-authenticate": 'DPoP error="use_dpop_nonce"',
          },
        );
      if (options.revoked?.includes(token))
        return reply(
          401,
          { error: "invalid_token" },
          {
            "www-authenticate": 'DPoP error="invalid_token"',
          },
        );
      return options.pdsAnswer?.(request) ?? reply(200, { token: `service-for-${token}` });
    }
    return reply(404, { error: "NoRoute" });
  };
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const text = request.body._tag === "Uint8Array" ? decoder.decode(request.body.body) : "";
      const isForm = request.headers["content-type"]?.includes("x-www-form-urlencoded") ?? false;
      const recorded: Seen = {
        method: request.method,
        url: new URL(
          `${request.url}${request.urlParams.params.length === 0 ? "" : `?${UrlParams.toString(request.urlParams)}`}`,
        ),
        headers: request.headers,
        form: new URLSearchParams(isForm ? text : ""),
        json: !isForm && text !== "" ? JSON.parse(text) : undefined,
      };
      seen.push(recorded);
      return HttpClientResponse.fromWeb(request, answer(recorded));
    }),
  );
  return {
    http,
    seen,
    to: (path: string) =>
      seen.filter((request) => `${request.url.origin}${request.url.pathname}` === path),
    deliver: (state: string, query: string) => callbacks.set(state, query),
  };
}

const session = (overrides: Partial<TangledOAuth.Session> = {}): TangledOAuth.Session => ({
  version: 2,
  did: DID,
  pds: PDS,
  issuer: ISSUER,
  tokenEndpoint: `${ISSUER}/oauth/token`,
  dpopKey: TangledOAuth.makeDpopKey(),
  accessToken: "access-0",
  refreshToken: "refresh-0",
  expiresAt: 3_600_000,
  scope: TangledOAuth.SCOPE,
  ...overrides,
});

const signedIn = (overrides?: Partial<TangledOAuth.Session>) => ({
  "tangled.org": JSON.stringify(session(overrides)),
});

function harness(
  options: Parameters<typeof fakeWorld>[0] & { readonly signIns?: Record<string, string> } = {},
) {
  const world = fakeWorld(options);
  const host = TestSourceControlHost.layer({
    settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sourceControlHosts: { tangled: { signIns: options.signIns ?? {} } },
    }),
  });
  const layer = Layer.effect(TangledAuth, TangledAuthLive.make({ relayOrigin: RELAY })).pipe(
    Layer.provideMerge(host),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, world.http)),
    Layer.provide(Layer.succeed(PublicHostGuard, literalHostGuard)),
  );
  return { layer, world };
}

const storedSession = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const settings = yield* host.settings.get;
  const raw = (settings.sourceControlHosts.tangled as { signIns: Record<string, string> }).signIns[
    "tangled.org"
  ];
  return raw === undefined ? null : (JSON.parse(raw) as TangledOAuth.Session);
});

describe("TangledAuthLive sign-in", () => {
  it.effect("signs in as a public client with PKCE, PAR and DPoP-bound tokens", () => {
    const { layer, world } = harness();
    return Effect.gen(function* () {
      const { signIn } = yield* TangledAuth;
      const prompt = yield* signIn.start("Tangled.org", "@Kaeden.codes");
      expect(prompt.expiresAt).toBe(600_000);
      const authorize = new URL(prompt.verificationUri);
      expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/oauth/authorize`);
      expect(Object.fromEntries(authorize.searchParams)).toEqual({
        client_id: CLIENT_ID,
        request_uri: "urn:request:1",
      });

      // The authorization server asked for a nonce, so the PAR went twice.
      const pars = world.to(`${ISSUER}/oauth/par`);
      expect(pars).toHaveLength(2);
      const par = pars[1]!;
      expect(proofClaims(par.headers.dpop)).toMatchObject({
        htm: "POST",
        htu: `${ISSUER}/oauth/par`,
        nonce: "nonce-auth.example",
      });
      const state = par.form.get("state") ?? "";
      expect(Object.fromEntries(par.form)).toEqual({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: `${RELAY}/tangled/callback`,
        scope: TangledOAuth.SCOPE,
        state,
        code_challenge: par.form.get("code_challenge"),
        code_challenge_method: "S256",
        login_hint: "kaeden.codes",
      });
      expect(world.to(`${RELAY}/tangled/start`)[0]?.json).toEqual({ state });

      const waiting = yield* Effect.forkChild(signIn.wait("tangled.org"));
      yield* TestClock.adjust("4 seconds");
      world.deliver(state, `code=abc&state=${state}&iss=${encodeURIComponent(ISSUER)}`);
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(waiting)).toEqual({ account: "kaeden.codes" });

      const token = world.to(`${ISSUER}/oauth/token`).at(-1)!;
      expect(Object.fromEntries(token.form)).toMatchObject({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: "abc",
        redirect_uri: `${RELAY}/tangled/callback`,
      });
      expect(sha256(token.form.get("code_verifier") ?? "")).toBe(par.form.get("code_challenge"));
      expect(proofClaims(token.headers.dpop).jwk).toBeUndefined();
      expect(yield* storedSession).toMatchObject({
        version: 2,
        did: DID,
        pds: PDS,
        issuer: ISSUER,
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: 3_606_000,
      });
    }).pipe(Effect.provide(layer));
  });

  const started = (world: ReturnType<typeof fakeWorld>) =>
    world.to(`${ISSUER}/oauth/par`).at(-1)?.form.get("state") ?? "";

  it.effect("refuses a callback from another issuer", () => {
    const { layer, world } = harness();
    return Effect.gen(function* () {
      const { signIn } = yield* TangledAuth;
      yield* signIn.start("tangled.org", "kaeden.codes");
      const state = started(world);
      world.deliver(
        state,
        `code=abc&state=${state}&iss=${encodeURIComponent("https://evil.example")}`,
      );
      const failure = yield* Effect.flip(signIn.wait("tangled.org"));
      expect(failure.reason).toBe("failed");
      expect(world.to(`${ISSUER}/oauth/token`)).toEqual([]);
      expect(yield* storedSession).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a sign-in the user declined", () => {
    const { layer, world } = harness();
    return Effect.gen(function* () {
      const { signIn } = yield* TangledAuth;
      yield* signIn.start("tangled.org", "kaeden.codes");
      const state = started(world);
      world.deliver(state, `error=access_denied&state=${state}&iss=${encodeURIComponent(ISSUER)}`);
      expect((yield* Effect.flip(signIn.wait("tangled.org"))).reason).toBe("denied");
    }).pipe(Effect.provide(layer));
  });

  it.effect("expires a sign-in nobody approved", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const { signIn } = yield* TangledAuth;
      yield* signIn.start("tangled.org", "kaeden.codes");
      const waiting = yield* Effect.forkChild(Effect.flip(signIn.wait("tangled.org")));
      yield* TestClock.adjust("11 minutes");
      expect((yield* Fiber.join(waiting)).reason).toBe("expired");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops polling the relay once cancelled", () => {
    const { layer, world } = harness();
    return Effect.gen(function* () {
      const { signIn } = yield* TangledAuth;
      yield* signIn.start("tangled.org", "kaeden.codes");
      const waiting = yield* Effect.forkChild(Effect.flip(signIn.wait("tangled.org")));
      yield* TestClock.adjust("2 seconds");
      yield* signIn.cancel("tangled.org");
      expect((yield* Fiber.join(waiting)).reason).toBe("cancelled");
      const polled = world.seen.length;
      yield* TestClock.adjust("1 minute");
      expect(world.seen).toHaveLength(polled);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to start without a handle, off tangled.org, or at a private PDS", () => {
    const { layer, world } = harness({ pds: "https://127.0.0.1:2583" });
    return Effect.gen(function* () {
      const { signIn } = yield* TangledAuth;
      expect((yield* Effect.flip(signIn.start("tangled.org", undefined))).reason).toBe("failed");
      expect((yield* Effect.flip(signIn.start("knot.example", "kaeden.codes"))).reason).toBe(
        "unsupported",
      );
      const privatePds = yield* Effect.flip(signIn.start("tangled.org", "kaeden.codes"));
      expect(privatePds.detail).toContain("is not a public HTTPS server");
      expect(world.seen.map((request) => request.url.host)).toEqual(["api.tangled.org"]);
    }).pipe(Effect.provide(layer));
  });
});

describe("TangledAuthLive session", () => {
  it.effect("names the stored session's account", () =>
    Effect.gen(function* () {
      const auth = yield* TangledAuth;
      expect(yield* auth.viewer).toEqual(Option.some({ did: DID, handle: "kaeden.codes" }));
    }).pipe(Effect.provide(harness({ signIns: signedIn() }).layer)),
  );

  it.effect("reads a session the old OAuth library saved as signed out", () =>
    Effect.gen(function* () {
      const auth = yield* TangledAuth;
      expect(yield* auth.viewer).toEqual(Option.none());
      expect((yield* Effect.flip(auth.serviceAuth({ aud: DID, lxm: "x" }))).reason).toBe(
        "not-signed-in",
      );
    }).pipe(
      Effect.provide(
        harness({
          signIns: {
            "tangled.org": JSON.stringify({
              dpopJwk: { kty: "EC" },
              authMethod: { method: "private_key_jwt", kid: "relay-1" },
              tokenSet: { sub: DID, access_token: "a", refresh_token: "r" },
            }),
          },
        }).layer,
      ),
    ),
  );

  it.effect("mints a service-auth token with a DPoP-bound access token", () => {
    const { layer, world } = harness({ signIns: signedIn() });
    return Effect.gen(function* () {
      const auth = yield* TangledAuth;
      const token = yield* auth.serviceAuth({
        aud: "did:web:knot1.tangled.sh",
        lxm: "org.tangled.git.receivePack",
      });
      expect(token).toBe("service-for-access-0");
      const calls = world.to(`${PDS}/xrpc/com.atproto.server.getServiceAuth`);
      // Asked again with the nonce the PDS wanted.
      expect(calls).toHaveLength(2);
      const call = calls[1]!;
      expect(Object.fromEntries(call.url.searchParams)).toEqual({
        aud: "did:web:knot1.tangled.sh",
        lxm: "org.tangled.git.receivePack",
      });
      expect(call.headers.authorization).toBe("DPoP access-0");
      expect(proofClaims(call.headers.dpop)).toMatchObject({
        htm: "GET",
        htu: `${PDS}/xrpc/com.atproto.server.getServiceAuth`,
        ath: sha256("access-0"),
        nonce: "nonce-pds.example",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refreshes a lapsing access token before using it, and keeps the new one", () => {
    const { layer, world } = harness({ signIns: signedIn({ expiresAt: 30_000 }) });
    return Effect.gen(function* () {
      const auth = yield* TangledAuth;
      yield* Effect.all(
        [auth.serviceAuth({ aud: DID, lxm: "a" }), auth.serviceAuth({ aud: DID, lxm: "b" })],
        {
          concurrency: 2,
        },
      );
      const refreshes = world
        .to(`${ISSUER}/oauth/token`)
        .filter((request) => request.form.get("refresh_token") !== null);
      // A refresh token works once, so the two calls share one refresh.
      expect(refreshes.map((request) => request.form.get("refresh_token"))).toEqual([
        "refresh-0",
        "refresh-0",
      ]);
      expect(refreshes[1]?.form.get("client_id")).toBe(CLIENT_ID);
      expect(yield* storedSession).toMatchObject({
        accessToken: "access-1",
        refreshToken: "refresh-1",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refreshes once when the PDS refuses an access token, then retries", () => {
    const { layer } = harness({ signIns: signedIn(), revoked: ["access-0"] });
    return Effect.gen(function* () {
      const auth = yield* TangledAuth;
      expect(yield* auth.serviceAuth({ aud: DID, lxm: "a" })).toBe("service-for-access-1");
    }).pipe(Effect.provide(layer));
  });

  it.effect("signs out when the authorization server refuses the refresh token", () => {
    const { layer } = harness({
      signIns: signedIn(),
      revoked: ["access-0"],
      refresh: "invalid_grant",
    });
    return Effect.gen(function* () {
      const auth = yield* TangledAuth;
      expect((yield* Effect.flip(auth.serviceAuth({ aud: DID, lxm: "a" }))).reason).toBe("expired");
      expect(yield* storedSession).toBeNull();
      expect(yield* auth.viewer).toEqual(Option.none());
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads a PDS refusal as failed", () =>
    Effect.gen(function* () {
      const auth = yield* TangledAuth;
      const failure = yield* Effect.flip(auth.serviceAuth({ aud: DID, lxm: "a" }));
      expect(failure.reason).toBe("failed");
      expect(failure.detail).toContain("BadExpiration");
    }).pipe(
      Effect.provide(
        harness({
          signIns: signedIn(),
          pdsAnswer: () => reply(400, { error: "BadExpiration" }),
        }).layer,
      ),
    ),
  );

  it.effect("reads and writes the viewer's own records on their PDS", () => {
    const declaration = { uri: `at://${DID}/org.tangled.repo.declaration/demo`, cid: "bafydecl" };
    const { layer, world } = harness({
      signIns: signedIn(),
      pdsAnswer: (request) =>
        request.url.pathname.endsWith("getRecord")
          ? reply(400, { error: "RecordNotFound", message: "Could not locate record" })
          : reply(200, declaration),
    });
    return Effect.gen(function* () {
      const auth = yield* TangledAuth;
      const slot = { collection: "org.tangled.repo.declaration", rkey: "demo" };
      expect(Option.isNone(yield* auth.getRecord(slot))).toBe(true);
      const record = { $type: "org.tangled.repo.declaration", repo: "did:plc:newrepo" };
      expect(yield* auth.createRecord({ ...slot, record })).toEqual(declaration);
      const [read] = world.to(`${PDS}/xrpc/com.atproto.repo.getRecord`).slice(-1);
      expect(Object.fromEntries(read?.url.searchParams ?? [])).toEqual({ repo: DID, ...slot });
      const [write] = world.to(`${PDS}/xrpc/com.atproto.repo.createRecord`);
      expect(write?.method).toBe("POST");
      expect(write?.json).toEqual({ repo: DID, ...slot, record });
    }).pipe(Effect.provide(layer));
  });
});

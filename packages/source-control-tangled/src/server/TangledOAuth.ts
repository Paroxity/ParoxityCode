// @effect-diagnostics nodeBuiltinImport:off -- Effect's crypto has no synchronous P-256 keygen or sign.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import { isDid } from "../shared/definition.ts";
import { publicHttpsUrl, type HostGuard } from "./publicHost.ts";

/**
 * atproto OAuth as a public client: PKCE, pushed authorization requests and DPoP-bound tokens,
 * the parts of the spec T3 needs and nothing else. https://atproto.com/specs/oauth
 */

/** Only what T3 writes; it must match the relay's client metadata in `infra/tangled-oauth`. */
export const SCOPE = [
  "atproto",
  "repo:org.tangled.repo.declaration",
  "rpc:com.atproto.repo.createRecord?aud=*",
  "rpc:com.atproto.repo.putRecord?aud=*",
  "rpc:com.atproto.repo.deleteRecord?aud=*",
  "rpc:org.tangled.repo.createRepo?aud=*",
  "rpc:org.tangled.repo.deleteRepo?aud=*",
  "rpc:org.tangled.review.submitPatch?aud=*",
  "rpc:org.tangled.git.receivePack?aud=*",
].join(" ");

const REQUEST_TIMEOUT = Duration.seconds(15);

export class OAuthError extends Schema.TaggedError<OAuthError>()("OAuthError", {
  /** The OAuth error code a server answered with, as `invalid_grant`. */
  error: Schema.optional(Schema.String),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const DpopJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
  d: Schema.String,
});
export type DpopJwk = typeof DpopJwk.Type;

/** What a session keeps: the DPoP key its tokens are bound to and where to refresh them. */
export const Session = Schema.Struct({
  version: Schema.Literal(2),
  did: Schema.String,
  pds: Schema.String,
  issuer: Schema.String,
  tokenEndpoint: Schema.String,
  dpopKey: DpopJwk,
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  /** Epoch milliseconds. */
  expiresAt: Schema.Number,
  scope: Schema.String,
});
export type Session = typeof Session.Type;

const ProtectedResource = Schema.Struct({
  authorization_servers: Schema.NonEmptyArray(Schema.String),
});

const ServerMetadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  pushed_authorization_request_endpoint: Schema.String,
  dpop_signing_alg_values_supported: Schema.optional(Schema.Array(Schema.String)),
});
export type ServerMetadata = typeof ServerMetadata.Type;

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  scope: Schema.String,
  sub: Schema.String,
});
export type TokenResponse = typeof TokenResponse.Type;

const OAuthProblem = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});
const decodeProblem = Schema.decodeUnknownOption(OAuthProblem);

const base64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const randomToken = (bytes: number) => base64url(NodeCrypto.randomBytes(bytes));

export const makeDpopKey = (): DpopJwk => {
  const { privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { x = "", y = "", d = "" } = privateKey.export({ format: "jwk" });
  return { kty: "EC", crv: "P-256", x, y, d };
};

/** A PKCE verifier and its S256 challenge, and a `state` the relay files the callback under. */
export const makeAuthorizationSecrets = () => {
  const verifier = randomToken(32);
  return {
    verifier,
    challenge: base64url(NodeCrypto.createHash("sha256").update(verifier).digest()),
    state: randomToken(24),
  };
};

const htuOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
};

const dpopProof = Effect.fn("TangledOAuth.dpopProof")(function* (
  key: DpopJwk,
  input: {
    readonly method: string;
    readonly url: string;
    readonly nonce: string | undefined;
    readonly accessToken?: string;
  },
) {
  const iat = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
  };
  const claims = {
    jti: randomToken(16),
    htm: input.method,
    htu: htuOf(input.url),
    iat,
    ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
    ...(input.accessToken === undefined
      ? {}
      : { ath: base64url(NodeCrypto.createHash("sha256").update(input.accessToken).digest()) }),
  };
  const signingInput = `${base64url(encodeJson(header))}.${base64url(encodeJson(claims))}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: NodeCrypto.createPrivateKey({ key, format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
});

const asOAuthError = (detail: string) => (cause: unknown) => new OAuthError({ detail, cause });

const readJson = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(Effect.orElseSucceed((): unknown => null));

const decode =
  <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, detail: string) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(asOAuthError(detail)));

const wantsNonce = (response: HttpClientResponse.HttpClientResponse, body: unknown) =>
  response.headers["dpop-nonce"] !== undefined &&
  (Option.getOrUndefined(decodeProblem(body))?.error === "use_dpop_nonce" ||
    (response.headers["www-authenticate"] ?? "").includes("use_dpop_nonce"));

/** The protocol over one HTTP client, with the DPoP nonces each origin last handed out. */
export const makeClient = (http: HttpClient.HttpClient, guard: HostGuard) => {
  const nonces = new Map<string, string>();
  // A redirect would carry the request past the host guard, and a token along with it.
  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    http
      .execute(request)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));

  const getJson = <S extends Schema.Codec<unknown, unknown, never, never>>(url: URL, schema: S) =>
    execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? readJson(response)
          : Effect.fail(
              new OAuthError({ detail: `${url.host} answered HTTP ${response.status}.` }),
            ),
      ),
      Effect.flatMap(decode(schema, `${url.host} sent unreadable OAuth metadata.`)),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((cause) =>
        cause._tag === "OAuthError"
          ? cause
          : new OAuthError({ detail: `Could not reach ${url.host}.`, cause }),
      ),
    );

  const authorizationServer = Effect.fn("TangledOAuth.authorizationServer")(function* (
    issuerUrl: string,
  ) {
    const issuer = yield* publicHttpsUrl(guard, issuerUrl).pipe(
      Effect.mapError(asOAuthError(`${issuerUrl} is not a public HTTPS server.`)),
    );
    const metadata = yield* getJson(
      new URL("/.well-known/oauth-authorization-server", issuer),
      ServerMetadata,
    );
    if (metadata.issuer !== issuer.origin)
      return yield* new OAuthError({ detail: `${issuer.host} names another issuer.` });
    if (
      metadata.dpop_signing_alg_values_supported !== undefined &&
      !metadata.dpop_signing_alg_values_supported.includes("ES256")
    )
      return yield* new OAuthError({ detail: `${issuer.host} does not take ES256 DPoP proofs.` });
    for (const endpoint of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.pushed_authorization_request_endpoint,
    ])
      yield* publicHttpsUrl(guard, endpoint).pipe(
        Effect.mapError(asOAuthError(`${issuer.host} names an endpoint that is not public.`)),
      );
    return metadata;
  });

  /** The authorization server a PDS names; an entryway URL may be one itself. */
  const discover = Effect.fn("TangledOAuth.discover")(function* (pdsUrl: string) {
    const pds = yield* publicHttpsUrl(guard, pdsUrl).pipe(
      Effect.mapError(asOAuthError(`${pdsUrl} is not a public HTTPS server.`)),
    );
    const resource = yield* getJson(
      new URL("/.well-known/oauth-protected-resource", pds),
      ProtectedResource,
    ).pipe(Effect.option);
    return yield* authorizationServer(
      Option.match(resource, {
        onNone: () => pds.origin,
        onSome: (found) => found.authorization_servers[0],
      }),
    );
  });

  /** A request with a DPoP proof, asked again once with the nonce the server wants. */
  const dpopExecute = Effect.fn("TangledOAuth.dpopExecute")(function* (
    key: DpopJwk,
    request: HttpClientRequest.HttpClientRequest,
    accessToken?: string,
  ) {
    const origin = new URL(request.url).origin;
    const attempt = Effect.gen(function* () {
      const proof = yield* dpopProof(key, {
        method: request.method,
        url: request.url,
        nonce: nonces.get(origin),
        ...(accessToken === undefined ? {} : { accessToken }),
      });
      const response = yield* execute(
        HttpClientRequest.setHeaders(request, {
          dpop: proof,
          ...(accessToken === undefined ? {} : { authorization: `DPoP ${accessToken}` }),
        }),
      );
      const nonce = response.headers["dpop-nonce"];
      if (nonce !== undefined) nonces.set(origin, nonce);
      return { response, body: yield* readJson(response) };
    });
    const once = attempt.pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(
        (cause) =>
          new OAuthError({ detail: `Could not reach ${new URL(request.url).host}.`, cause }),
      ),
    );
    const first = yield* once;
    return wantsNonce(first.response, first.body) ? yield* once : first;
  });

  /** A form POST to an authorization server, decoded as `schema` or failed with its OAuth error. */
  const formPost = <S extends Schema.Codec<unknown, unknown, never, never>>(
    key: DpopJwk,
    url: string,
    form: Record<string, string>,
    schema: S,
  ) =>
    dpopExecute(key, HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUrlParams(form))).pipe(
      Effect.flatMap(({ response, body }) => {
        if (response.status >= 200 && response.status < 300)
          return decode(schema, `${new URL(url).host} sent an unreadable answer.`)(body);
        const problem = Option.getOrUndefined(decodeProblem(body));
        return Effect.fail(
          new OAuthError({
            ...(problem === undefined ? {} : { error: problem.error }),
            detail:
              problem?.error_description ??
              problem?.error ??
              `${new URL(url).host} answered HTTP ${response.status}.`,
          }),
        );
      }),
    );

  const pushAuthorization = (input: {
    readonly server: ServerMetadata;
    readonly key: DpopJwk;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly challenge: string;
    readonly loginHint: string | undefined;
  }) =>
    formPost(
      input.key,
      input.server.pushed_authorization_request_endpoint,
      {
        client_id: input.clientId,
        response_type: "code",
        redirect_uri: input.redirectUri,
        scope: SCOPE,
        state: input.state,
        code_challenge: input.challenge,
        code_challenge_method: "S256",
        ...(input.loginHint === undefined ? {} : { login_hint: input.loginHint }),
      },
      Schema.Struct({ request_uri: Schema.String }),
    ).pipe(
      Effect.map(({ request_uri }) => {
        const url = new URL(input.server.authorization_endpoint);
        url.searchParams.set("client_id", input.clientId);
        url.searchParams.set("request_uri", request_uri);
        return url.toString();
      }),
    );

  const checkTokens = (tokens: TokenResponse) =>
    tokens.token_type.toLowerCase() !== "dpop" ||
    !isDid(tokens.sub) ||
    !tokens.scope.split(" ").includes("atproto")
      ? Effect.fail(new OAuthError({ detail: "Your PDS answered with tokens T3 cannot use." }))
      : Effect.succeed(tokens);

  const exchangeCode = (input: {
    readonly server: ServerMetadata;
    readonly key: DpopJwk;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly code: string;
    readonly verifier: string;
  }) =>
    formPost(
      input.key,
      input.server.token_endpoint,
      {
        grant_type: "authorization_code",
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        code: input.code,
        code_verifier: input.verifier,
      },
      TokenResponse,
    ).pipe(Effect.flatMap(checkTokens));

  const refresh = (session: Session, clientId: string) =>
    session.refreshToken === undefined
      ? Effect.fail(
          new OAuthError({ error: "invalid_grant", detail: "The session cannot be refreshed." }),
        )
      : formPost(
          session.dpopKey,
          session.tokenEndpoint,
          { grant_type: "refresh_token", client_id: clientId, refresh_token: session.refreshToken },
          TokenResponse,
        ).pipe(
          Effect.flatMap(checkTokens),
          Effect.filterOrFail(
            (tokens) => tokens.sub === session.did,
            () => new OAuthError({ detail: "Your PDS refreshed the session for another account." }),
          ),
        );

  /** An XRPC call to the session's PDS with its DPoP-bound access token. */
  const resource = (session: Session, request: HttpClientRequest.HttpClientRequest) =>
    dpopExecute(session.dpopKey, request, session.accessToken);

  return { discover, authorizationServer, pushAuthorization, exchangeCode, refresh, resource };
};

/** The session a token response starts, with its expiry as an instant. */
export const sessionOf = Effect.fn("TangledOAuth.sessionOf")(function* (input: {
  readonly tokens: TokenResponse;
  readonly server: Pick<ServerMetadata, "issuer" | "token_endpoint">;
  readonly pds: string;
  readonly key: DpopJwk;
  readonly previous?: Session;
}) {
  const now = yield* Clock.currentTimeMillis;
  const refreshToken = input.tokens.refresh_token ?? input.previous?.refreshToken;
  return {
    version: 2,
    did: input.tokens.sub,
    pds: input.pds,
    issuer: input.server.issuer,
    tokenEndpoint: input.server.token_endpoint,
    dpopKey: input.key,
    accessToken: input.tokens.access_token,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAt: now + (input.tokens.expires_in ?? 300) * 1000,
    scope: input.tokens.scope,
  } satisfies Session;
});

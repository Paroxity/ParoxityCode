// @effect-diagnostics globalDate:off - a plain fetch Worker with no Effect runtime.
/**
 * The public OAuth client T3 servers sign in to Tangled as: its metadata and redirect target. A
 * server files a sign-in's `state` and polls for the callback with the token it got back. D1, not
 * KV: start and callback hit different locations seconds apart, where KV can miss or race a key.
 */

export interface Env {
  readonly DB: D1Database;
  /** This Worker's origin, as `https://tangled-oauth.code.paroxity.net`. */
  readonly ORIGIN: string;
}

/** What T3 writes; `SCOPE` in `packages/source-control-tangled` must ask for the same. */
export const SCOPES = [
  "atproto",
  "repo:org.tangled.repo.declaration",
  "rpc:com.atproto.repo.createRecord?aud=*",
  "rpc:com.atproto.repo.putRecord?aud=*",
  "rpc:com.atproto.repo.deleteRecord?aud=*",
  "rpc:org.tangled.repo.createRepo?aud=*",
  "rpc:org.tangled.repo.deleteRepo?aud=*",
  "rpc:org.tangled.review.submitPatch?aud=*",
  "rpc:org.tangled.git.receivePack?aud=*",
];

/** How long a sign-in waits for its callback and its server; one takes minutes at most. */
export const CALLBACK_SECONDS = 15 * 60;
const CALLBACK_PARAMS = ["code", "state", "iss", "error", "error_description"] as const;
const STATE = /^[A-Za-z0-9_-]{16,128}$/u;
const BEARER = /^Bearer ([A-Za-z0-9_-]{32,128})$/u;

export function clientId(origin: string): string {
  return `${origin}/tangled/client-metadata.json`;
}

export function clientMetadata(origin: string) {
  return {
    client_id: clientId(origin),
    client_name: "Paroxity Code",
    client_uri: origin,
    application_type: "web",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    redirect_uris: [`${origin}/tangled/callback`],
    scope: SCOPES.join(" "),
    token_endpoint_auth_method: "none",
    dpop_bound_access_tokens: true,
  };
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");

const sha256 = async (value: string) =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));

const page = (title: string, message: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px system-ui;margin:20vh auto;max-width:28rem;text-align:center"><h1 style="font-size:1.25rem">${title}</h1><p>${message}</p></body>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/gu, (character) => `&#${character.codePointAt(0)};`);

const NO_STORE = { "cache-control": "no-store" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const now = Math.floor(Date.now() / 1000);

    if (request.method === "GET" && url.pathname === "/tangled/client-metadata.json") {
      return Response.json(clientMetadata(env.ORIGIN), {
        headers: { "cache-control": "public, max-age=300" },
      });
    }

    if (request.method === "POST" && url.pathname === "/tangled/start") {
      const body = (await request.json().catch(() => null)) as { state?: unknown } | null;
      const state = typeof body?.state === "string" ? body.state : "";
      if (!STATE.test(state)) return Response.json({ error: "invalid_state" }, { status: 400 });
      const pollToken = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const [, inserted] = await env.DB.batch([
        env.DB.prepare("DELETE FROM callbacks WHERE expires_at < ?").bind(now),
        env.DB.prepare(
          "INSERT INTO callbacks (state, poll_hash, expires_at) VALUES (?, ?, ?) ON CONFLICT (state) DO NOTHING",
        ).bind(state, await sha256(pollToken), now + CALLBACK_SECONDS),
      ]);
      if ((inserted?.meta.changes ?? 0) === 0)
        return Response.json({ error: "state_in_use" }, { status: 409, headers: NO_STORE });
      return Response.json({ pollToken }, { headers: NO_STORE });
    }

    if (request.method === "GET" && url.pathname === "/tangled/callback") {
      const state = url.searchParams.get("state") ?? "";
      const query = new URLSearchParams();
      for (const name of CALLBACK_PARAMS) {
        const value = url.searchParams.get(name);
        if (value !== null) query.set(name, value);
      }
      // Only a state a server filed takes a callback, and only its first one.
      const filed = STATE.test(state)
        ? await env.DB.prepare(
            "UPDATE callbacks SET query = ? WHERE state = ? AND query IS NULL AND expires_at >= ?",
          )
            .bind(query.toString(), state, now)
            .run()
        : null;
      if ((filed?.meta.changes ?? 0) === 0)
        return page("Sign-in failed", "This sign-in link is not valid or was already used.", 400);
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      return error === null
        ? page("Signed in to Tangled", "You can close this tab and return to Paroxity Code.")
        : page("Sign-in did not finish", escapeHtml(error));
    }

    const pending = /^\/tangled\/callback\/([A-Za-z0-9_-]+)$/u.exec(url.pathname)?.[1];
    if (request.method === "GET" && pending !== undefined && STATE.test(pending)) {
      const token = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
      if (token === undefined) return new Response(null, { status: 401, headers: NO_STORE });
      const pollHash = await sha256(token);
      const delivered = await env.DB.prepare(
        "DELETE FROM callbacks WHERE state = ? AND poll_hash = ? AND query IS NOT NULL AND expires_at >= ? RETURNING query",
      )
        .bind(pending, pollHash, now)
        .first<{ query: string }>();
      if (delivered !== null)
        return new Response(delivered.query, {
          headers: { "content-type": "application/x-www-form-urlencoded", ...NO_STORE },
        });
      const waiting = await env.DB.prepare(
        "SELECT 1 AS waiting FROM callbacks WHERE state = ? AND poll_hash = ? AND expires_at >= ?",
      )
        .bind(pending, pollHash, now)
        .first<{ waiting: number }>();
      return new Response(null, { status: waiting === null ? 404 : 204, headers: NO_STORE });
    }

    return new Response("Not found", { status: 404 });
  },
};

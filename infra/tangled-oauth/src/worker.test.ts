// @effect-diagnostics nodeBuiltinImport:off - runs the Worker's SQL and migrations on node:sqlite.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";

import worker, { CALLBACK_SECONDS, clientMetadata, type Env } from "./worker.ts";

const ORIGIN = "https://t3-oauth.example";
const NOW = 1_800_000_000;
const STATE = "AAAAAAAAAAAAAAAAAAAAAA";
const MIGRATIONS = NodePath.join(import.meta.dirname, "..", "migrations");

/** D1's statement API over an in-memory SQLite database with the Worker's migrations applied. */
function sqliteD1(): D1Database {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  for (const file of NodeFS.readdirSync(MIGRATIONS).toSorted())
    db.exec(NodeFS.readFileSync(NodePath.join(MIGRATIONS, file), "utf8"));
  const statement = (sql: string, args: ReadonlyArray<NodeSqlite.SQLInputValue> = []) => ({
    bind: (...values: ReadonlyArray<NodeSqlite.SQLInputValue>) => statement(sql, values),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    first: async () => db.prepare(sql).get(...args) ?? null,
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReadonlyArray<{ run: () => Promise<unknown> }>) => {
      const results = [];
      for (const s of statements) results.push(await s.run());
      return results;
    },
  } as unknown as D1Database;
}

function relay() {
  const env: Env = { DB: sqliteD1(), ORIGIN };
  const call = (path: string, init?: RequestInit) =>
    worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
  const start = async (state = STATE) => {
    const response = await call("/tangled/start", {
      method: "POST",
      body: JSON.stringify({ state }),
    });
    return { response, ...((await response.clone().json()) as { pollToken?: string }) };
  };
  const poll = (pollToken: string | undefined, state = STATE) =>
    call(`/tangled/callback/${state}`, {
      headers: pollToken === undefined ? {} : { authorization: `Bearer ${pollToken}` },
    });
  const callback = (query: string) => call(`/tangled/callback?${query}`);
  return { call, start, poll, callback };
}

describe("relay", () => {
  it("publishes a public client whose tokens are DPoP-bound", async () => {
    const response = await relay().call("/tangled/client-metadata.json");
    const metadata = (await response.json()) as ReturnType<typeof clientMetadata>;
    expect(metadata).toMatchObject({
      client_id: `${ORIGIN}/tangled/client-metadata.json`,
      redirect_uris: [`${ORIGIN}/tangled/callback`],
      token_endpoint_auth_method: "none",
      dpop_bound_access_tokens: true,
    });
    expect(metadata).not.toHaveProperty("jwks_uri");
    expect(metadata.scope.split(" ")).not.toContain("blob:image/*");
  });

  it("signs nothing: the assertion and key routes are gone", async () => {
    const { call } = relay();
    expect((await call("/tangled/assertion", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await call("/tangled/jwks.json")).status).toBe(404);
  });

  it("hands a filed state's callback once, and only to its poll token", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const { start, poll, callback } = relay();
    const { pollToken } = await start();
    expect(pollToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect((await poll(pollToken)).status).toBe(204);

    const query = `code=abc&state=${STATE}&iss=https%3A%2F%2Fbsky.social&extra=1`;
    expect((await callback(query)).status).toBe(200);
    expect((await poll(undefined)).status).toBe(401);
    expect((await poll("x".repeat(43))).status).toBe(404);

    const delivered = await poll(pollToken);
    expect(new URLSearchParams(await delivered.text())).toEqual(
      new URLSearchParams({ code: "abc", state: STATE, iss: "https://bsky.social" }),
    );
    expect((await poll(pollToken)).status).toBe(404);
  });

  it("refuses a callback for a state no server filed", async () => {
    const { callback, start, poll } = relay();
    expect((await callback(`code=abc&state=${STATE}`)).status).toBe(400);
    expect((await callback("code=abc&state=x")).status).toBe(400);
    // Filing it afterwards does not resurrect the stray callback.
    const { pollToken } = await start();
    expect((await poll(pollToken)).status).toBe(204);
  });

  it("never lets a second callback replace the first", async () => {
    const { start, poll, callback } = relay();
    const { pollToken } = await start();
    expect((await callback(`code=first&state=${STATE}`)).status).toBe(200);
    expect((await callback(`code=hijack&state=${STATE}`)).status).toBe(400);
    expect(new URLSearchParams(await (await poll(pollToken)).text()).get("code")).toBe("first");
  });

  it("refuses to file a state twice, or one that is malformed", async () => {
    const { start } = relay();
    expect((await start()).response.status).toBe(200);
    expect((await start()).response.status).toBe(409);
    expect((await start("short")).response.status).toBe(400);
  });

  it("forgets a sign-in once it expires", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const { start, poll, callback } = relay();
    const { pollToken } = await start();
    now.mockReturnValue((NOW + CALLBACK_SECONDS + 1) * 1000);
    expect((await callback(`code=late&state=${STATE}`)).status).toBe(400);
    expect((await poll(pollToken)).status).toBe(404);
    // The next start sweeps the expired row, so the same state can be filed again.
    expect((await start()).response.status).toBe(200);
    now.mockRestore();
  });
});

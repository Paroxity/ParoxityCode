import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

/** Baked into Paroxity Code as Tangled's OAuth client ID, so it must never move. */
const DOMAIN = "tangled-oauth.code.paroxity.net";
const ZONE_NAME = "paroxity.net";

const Callbacks = Cloudflare.D1.Database("Callbacks", { migrations: "./migrations" });

const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  compatibility: { date: "2026-10-01" },
  domain: { name: DOMAIN, zoneName: ZONE_NAME },
  env: {
    DB: Callbacks,
    ORIGIN: `https://${DOMAIN}`,
  },
});

export default Alchemy.Stack(
  "T3TangledOAuth",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    yield* Callbacks;
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);

// @effect-diagnostics nodeBuiltinImport:off -- Effect has no address block list or getaddrinfo lookup.
import * as NodeDns from "node:dns";
import * as NodeNet from "node:net";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const LOOKUP_TIMEOUT = Duration.seconds(5);

// IANA special-purpose ranges that are not globally reachable. An IPv6 address must also be
// global unicast (2000::/3), which leaves out every form that embeds an IPv4 address.
const notGlobalV4 = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  notGlobalV4.addSubnet(network, prefix, "ipv4");
const globalUnicastV6 = new NodeNet.BlockList();
globalUnicastV6.addSubnet("2000::", 3, "ipv6");
const notGlobalV6 = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  notGlobalV6.addSubnet(network, prefix, "ipv6");

const isGloballyRoutable = (address: string) => {
  const family = NodeNet.isIP(address);
  if (family === 4) return !notGlobalV4.check(address, "ipv4");
  return (
    family === 6 && globalUnicastV6.check(address, "ipv6") && !notGlobalV6.check(address, "ipv6")
  );
};

const bare = (host: string) => host.replace(/^\[(.*)\]$/u, "$1").toLowerCase();

/** A host Tangled data named that the server refuses to send requests, or tokens, to. */
export class PrivateHostError extends Schema.TaggedError<PrivateHostError>()("PrivateHostError", {
  host: Schema.String,
}) {
  override get message(): string {
    return `${this.host} is not a public address.`;
  }
}

/** Refuses `localhost` and private address literals without resolving names. */
export const literalHostGuard = (rawHost: string): Effect.Effect<void, PrivateHostError> => {
  const host = bare(rawHost);
  return host === "localhost" ||
    host.endsWith(".localhost") ||
    (NodeNet.isIP(host) !== 0 && !isGloballyRoutable(host))
    ? Effect.fail(new PrivateHostError({ host }))
    : Effect.void;
};

const resolveAll = (host: string) =>
  Effect.callback<ReadonlyArray<NodeDns.LookupAddress>, Error>((resume) => {
    NodeDns.lookup(host, { all: true }, (error, addresses) =>
      resume(error === null ? Effect.succeed(addresses) : Effect.fail(error)),
    );
  });

/**
 * Also resolves a name and refuses it when any address is private. The connection resolves
 * again, so this stops a hostile identity or repository record, not a rebinding resolver.
 */
const resolvingHostGuard = Effect.fn("PublicHostGuard.resolve")(function* (rawHost: string) {
  yield* literalHostGuard(rawHost);
  const host = bare(rawHost);
  if (NodeNet.isIP(host) !== 0) return;
  const addresses = yield* resolveAll(host).pipe(
    Effect.timeout(LOOKUP_TIMEOUT),
    Effect.mapError(() => new PrivateHostError({ host })),
  );
  if (addresses.length === 0 || !addresses.every(({ address }) => isGloballyRoutable(address)))
    return yield* new PrivateHostError({ host });
});

/**
 * Checks a host taken from an identity, a repository record or OAuth metadata before the server
 * reaches it. Tests swap in `literalHostGuard`, since their fake hosts do not resolve.
 */
export class PublicHostGuard extends Context.Reference<HostGuard>(
  "@t3tools/source-control-tangled/server/PublicHostGuard",
  {
    defaultValue: () => resolvingHostGuard,
  },
) {}

export type HostGuard = (host: string) => Effect.Effect<void, PrivateHostError>;

/** An `https:` URL on a host `guard` passes, or a failure naming why not. */
export const publicHttpsUrl = Effect.fn("PublicHostGuard.publicHttpsUrl")(function* (
  guard: HostGuard,
  raw: string,
) {
  const url = URL.parse(raw);
  if (url === null || url.protocol !== "https:" || url.username !== "" || url.password !== "")
    return yield* new PrivateHostError({ host: raw });
  yield* guard(url.hostname);
  return url;
});

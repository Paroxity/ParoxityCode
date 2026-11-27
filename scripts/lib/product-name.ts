// @effect-diagnostics nodeBuiltinImport:off - Vite's build plugin runs before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Plugin } from "vite-plus";
import type { Rolldown } from "vite-plus/pack";

/** The name upstream's source and translation catalogs use for the app. */
export const UPSTREAM_PRODUCT_NAME = "T3 Code";

/** The fork's product name for this build, from `T3CODE_PRODUCT_NAME`; upstream's when unset. */
export function resolveProductName(env: Record<string, string | undefined>): string {
  return env.T3CODE_PRODUCT_NAME?.trim() || UPSTREAM_PRODUCT_NAME;
}

/**
 * Source text that keeps upstream's name, by file. Each entry is matched exactly, and the build
 * fails if one is missing, so a rebase that moves it gets looked at again.
 */
const KEEP_UPSTREAM_NAME: Readonly<Record<string, readonly string[]>> = {
  // Matched in launchers and units that earlier builds wrote to disk.
  "apps/desktop/src/app/DesktopCliShim.ts": [
    `"Written by T3 Code: runs the desktop app's bundled t3 CLI."`,
  ],
  "apps/desktop/src/snapShot/KdeSnapShot.ts": [`"Name=T3 Code SnapShots"`],
  "apps/server/src/cloud/bootService.ts": [
    `"Description=T3 Code server"`,
    "`    <Description>T3 Code server</Description>`",
  ],
  // Electron's app name keys the Keychain item that encrypts saved cookies and secrets.
  "apps/desktop/src/app/DesktopAppIdentity.ts": ["setName(`T3 Code ${"],
  // Names of earlier installs' profiles, looked up to migrate them.
  "apps/desktop/src/app/DesktopUserData.ts": [`"T3 Code (Dev)"`, `"T3 Code (Alpha)"`],
  "apps/desktop/src/app/DesktopLegacyLocalStorage.ts": [`"T3 Code (Alpha)"`],
  // Identities other services and peers know: Codex picks models by originator, peers strip
  // the link prefix, and the GitHub app and OAuth names are upstream's.
  "apps/server/src/provider/CodexProvider.ts": [`CODEX_CLIENT_NAME = "T3 Code"`],
  "apps/server/src/peer/PeerLinks.ts": [`LINK_CLIENT_NAME_PREFIX = "T3 Code · "`],
  "apps/server/src/provider/CodexChatGptAuth.ts": [`agent_name_hint: "T3 Code"`],
  "apps/server/src/provider/acp/AntigravityAcpSupport.ts": [`title: "T3 Code"`],
  "packages/provider-muse/src/server/sdk.ts": [`title: "T3 Code"`],
  "packages/source-control-github/src/shared/definition.ts": [`appName: "T3 Code for GitHub"`],
  // Author of commits pushed to the user's branches, with upstream's noreply address.
  "packages/source-control-github/src/server/githubStackRebase.ts": [
    `GIT_CONFIG_VALUE_1: "T3 Code"`,
  ],
};

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../..");
const NODE_MODULES = `${NodePath.sep}node_modules${NodePath.sep}`;
const GT_HASH_SOURCE = "function hashSource(";

/**
 * Fork: renames the app in a bundle without editing upstream's copy.
 *
 * Source text and catalogs are rewritten as they are bundled, except `KEEP_UPSTREAM_NAME`. GT keys
 * every translation by a hash of the English source, so GT's `hashSource` hashes the upstream
 * name instead; otherwise every string naming the app would lose its translations.
 */
function createRenameTransform(productName: string) {
  const state = { hashSourcePatched: false };
  const transform = (code: string, id: string): string | null => {
    if (id.includes(NODE_MODULES)) {
      if (!id.includes(`${NodePath.sep}generaltranslation${NodePath.sep}`)) return null;
      if (!code.includes(GT_HASH_SOURCE)) return null;
      state.hashSourcePatched = true;
      const unrename = JSON.stringify([productName, UPSTREAM_PRODUCT_NAME]);
      return `${code.replace(GT_HASH_SOURCE, "function __forkUpstreamHashSource(")}
function hashSource(input, hashFunction = hashString) {
  const [productName, upstreamName] = ${unrename};
  return __forkUpstreamHashSource(input, (text) => hashFunction(text.replaceAll(productName, upstreamName)));
}
`;
    }
    if (!code.includes(UPSTREAM_PRODUCT_NAME)) return null;
    const file = NodePath.relative(REPO_ROOT, id.split("?")[0] ?? id).replaceAll(NodePath.sep, "/");
    const kept = KEEP_UPSTREAM_NAME[file] ?? [];
    let protectedCode = code;
    kept.forEach((text, index) => {
      if (!protectedCode.includes(text)) {
        throw new Error(
          `fork:product-name expected ${file} to contain ${text}. Update KEEP_UPSTREAM_NAME in scripts/lib/product-name.ts.`,
        );
      }
      protectedCode = protectedCode.replaceAll(text, `\u0000fork-keep-${index}\u0000`);
    });
    let renamed = protectedCode.replaceAll(UPSTREAM_PRODUCT_NAME, productName);
    kept.forEach((text, index) => {
      renamed = renamed.replaceAll(`\u0000fork-keep-${index}\u0000`, text);
    });
    return renamed;
  };
  return { state, transform };
}

const MISSING_HASH_SOURCE =
  "fork:product-name did not find GT's hashSource, so renamed strings would lose their translations. Update scripts/lib/product-name.ts.";

/** The web build: source, catalogs, `index.html` and the web manifest. */
export function productNamePlugin(productName: string): Plugin[] {
  if (productName === UPSTREAM_PRODUCT_NAME) return [];
  const rename = (text: string) => text.replaceAll(UPSTREAM_PRODUCT_NAME, productName);
  const { state, transform } = createRenameTransform(productName);
  let outDir: string | undefined;

  const brandDefine: Plugin = {
    name: "fork:product-name-define",
    // Also in dev, so the drawn brand can be checked there; dev text keeps upstream's name.
    config: () => ({
      // Read by components that draw the brand rather than name it, such as T3Wordmark.
      define: { "import.meta.env.VITE_FORK_PRODUCT_NAME": JSON.stringify(productName) },
    }),
  };
  const renameText: Plugin = {
    name: "fork:product-name",
    apply: "build",
    enforce: "pre",
    configResolved(config) {
      outDir = NodePath.resolve(config.root, config.build.outDir);
    },
    transform(code, id) {
      const renamed = transform(code, id);
      return renamed === null ? null : { code: renamed, map: null };
    },
    // After the title plugin in apps/web/vite.config.ts, which writes the upstream name.
    transformIndexHtml: { order: "post", handler: rename },
    buildEnd(error) {
      if (!error && !state.hashSourcePatched) this.error(MISSING_HASH_SOURCE);
    },
    closeBundle() {
      // Vite copies public/ verbatim, so the PWA manifest is renamed after the copy.
      const manifest = outDir && NodePath.join(outDir, "manifest.webmanifest");
      if (manifest && NodeFS.existsSync(manifest)) {
        NodeFS.writeFileSync(manifest, rename(NodeFS.readFileSync(manifest, "utf8")));
      }
    },
  };
  return [brandDefine, renameText];
}

/** A `vp pack` bundle: the desktop main process and the server. Set `translated` where GT runs. */
export function productNamePackPlugin(
  productName: string,
  options: { readonly translated: boolean },
): Rolldown.Plugin[] {
  if (productName === UPSTREAM_PRODUCT_NAME) return [];
  const { state, transform } = createRenameTransform(productName);
  return [
    {
      name: "fork:product-name",
      transform(code, id) {
        const renamed = transform(code, id);
        return renamed === null ? null : { code: renamed, map: null };
      },
      buildEnd(error) {
        if (!error && options.translated && !state.hashSourcePatched) {
          this.error(MISSING_HASH_SOURCE);
        }
      },
    },
  ];
}

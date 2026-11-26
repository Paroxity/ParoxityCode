// @effect-diagnostics nodeBuiltinImport:off - Vite's build plugin runs before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Plugin } from "vite-plus";

/** The name upstream's source and translation catalogs use for the app. */
export const UPSTREAM_PRODUCT_NAME = "T3 Code";

/** The fork's product name for this build, from `T3CODE_PRODUCT_NAME`; upstream's when unset. */
export function resolveProductName(env: Record<string, string | undefined>): string {
  return env.T3CODE_PRODUCT_NAME?.trim() || UPSTREAM_PRODUCT_NAME;
}

const NODE_MODULES = `${NodePath.sep}node_modules${NodePath.sep}`;
const GT_HASH_SOURCE = "function hashSource(";

/**
 * Fork: renames the app in the web build without editing upstream's copy.
 *
 * Source text and catalogs are rewritten as they are bundled. GT keys every translation by a hash
 * of the English source, so GT's `hashSource` hashes the upstream name instead; otherwise every
 * string naming the app would lose its translations. The build fails if that hook is not found.
 */
export function productNamePlugin(productName: string): Plugin | undefined {
  if (productName === UPSTREAM_PRODUCT_NAME) return undefined;
  const rename = (text: string) => text.replaceAll(UPSTREAM_PRODUCT_NAME, productName);
  let hashSourcePatched = false;
  let outDir: string | undefined;

  return {
    name: "fork:product-name",
    apply: "build",
    enforce: "pre",
    configResolved(config) {
      outDir = NodePath.resolve(config.root, config.build.outDir);
    },
    transform(code, id) {
      if (id.includes(NODE_MODULES)) {
        if (!id.includes(`${NodePath.sep}generaltranslation${NodePath.sep}`)) return null;
        if (!code.includes(GT_HASH_SOURCE)) return null;
        hashSourcePatched = true;
        const unrename = JSON.stringify([productName, UPSTREAM_PRODUCT_NAME]);
        return {
          code: `${code.replace(GT_HASH_SOURCE, "function __forkUpstreamHashSource(")}
function hashSource(input, hashFunction = hashString) {
  const [productName, upstreamName] = ${unrename};
  return __forkUpstreamHashSource(input, (text) => hashFunction(text.replaceAll(productName, upstreamName)));
}
`,
          map: null,
        };
      }
      return code.includes(UPSTREAM_PRODUCT_NAME) ? { code: rename(code), map: null } : null;
    },
    // After the title plugin in apps/web/vite.config.ts, which writes the upstream name.
    transformIndexHtml: { order: "post", handler: rename },
    buildEnd(error) {
      if (!error && !hashSourcePatched) {
        this.error(
          "fork:product-name did not find GT's hashSource, so renamed strings would lose their translations. Update scripts/lib/product-name.ts.",
        );
      }
    },
    closeBundle() {
      // Vite copies public/ verbatim, so the PWA manifest is renamed after the copy.
      const manifest = outDir && NodePath.join(outDir, "manifest.webmanifest");
      if (manifest && NodeFS.existsSync(manifest)) {
        NodeFS.writeFileSync(manifest, rename(NodeFS.readFileSync(manifest, "utf8")));
      }
    },
  };
}

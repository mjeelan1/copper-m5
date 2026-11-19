// Lets a plain Node script import the app's TypeScript files, the way the
// Next.js server does: "@/lib/..." paths, .ts files and JSON data files.
// Import this first, then import the app files with `await import(...)`.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);

registerHooks({
  resolve: (specifier, context, next) => {
    if (specifier.startsWith("@/")) {
      const path = specifier.slice(2);
      const file = /\.(json|ts)$/.test(path) ? path : `${path}.ts`;
      return next(new URL(file, root).href, context);
    }
    // Next.js's entry points ("next/server") have no ESM map: add the .js.
    if (/^next\/[\w-]+$/.test(specifier))
      return next(`${specifier}.js`, context);
    return next(specifier, context);
  },
  load: (url, context, next) => {
    if (url.endsWith(".ts"))
      return next(url, { ...context, format: "module-typescript" });
    // The app imports JSON without `with { type: "json" }`; bundlers allow
    // that, Node doesn't, so hand Node the JSON as a module.
    if (url.startsWith("file:") && url.endsWith(".json"))
      return {
        format: "module",
        source: `export default ${readFileSync(new URL(url), "utf8")};`,
        shortCircuit: true,
      };
    return next(url, context);
  },
});

try {
  process.loadEnvFile(new URL(".env.local", root));
} catch {
  // No .env.local: the keys may already be in the environment (CI).
}

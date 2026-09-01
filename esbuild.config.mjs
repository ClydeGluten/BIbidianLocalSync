import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  alias: {
    ws: fileURLToPath(new URL("./node_modules/ws/index.js", import.meta.url))
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
  format: "cjs",
  footer: { js: "module.exports = module.exports.default;" },
  logLevel: "info",
  mainFields: ["module", "main"],
  minify: production,
  outfile: "main.js",
  platform: "browser",
  sourcemap: production ? false : "inline",
  target: "es2022",
  treeShaking: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development")
  }
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}

import * as esbuild from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

mkdirSync(dist, { recursive: true });
copyFileSync(join(root, "manifest.json"), join(dist, "manifest.json"));

const common = {
  bundle: true,
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
};

const contexts = [
  {
    ...common,
    entryPoints: [join(root, "src/content/index.ts")],
    outfile: join(dist, "content.js"),
    format: "iife",
  },
  {
    ...common,
    entryPoints: [join(root, "src/background/index.ts")],
    outfile: join(dist, "background.js"),
    format: "esm",
  },
];

if (watch) {
  const ctxs = await Promise.all(contexts.map((o) => esbuild.context(o)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("watching…");
} else {
  await Promise.all(contexts.map((o) => esbuild.build(o)));
  console.log("built → extension/dist/");
}

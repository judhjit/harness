import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
const directory = new URL("./dist/", import.meta.url);
mkdirSync(directory, { recursive: true });
await build({
  entryPoints: [new URL("./src/app.tsx", import.meta.url).pathname],
  bundle: true,
  minify: true,
  sourcemap: true,
  outfile: new URL("./dist/app.js", import.meta.url).pathname,
  jsx: "automatic",
  platform: "browser",
  target: "es2022",
});
copyFileSync(
  new URL("./src/index.html", import.meta.url),
  new URL("./dist/index.html", import.meta.url),
);

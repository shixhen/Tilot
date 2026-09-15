import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../packages/agent-core/src/", import.meta.url));
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) { await inspect(file); continue; }
    if (!file.endsWith(".ts")) continue;
    const source = await readFile(file, "utf8");
    // Core has no platform adapters or external imports in M0.1. Dynamic escapes are forbidden too.
    if (/\b(?:require\s*\(|import\s*\(|eval\s*\()|\/\/\/\s*<reference/.test(source)) throw new Error(`Forbidden dynamic dependency: ${file}`);
    for (const match of source.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      const target = relative(root, resolve(dirname(file), specifier));
      if (!specifier.startsWith(".") || target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) throw new Error(`Forbidden Core dependency: ${file} -> ${specifier}`);
    }
  }
}
await inspect(root);
// Inspect the compiler's transitive file graph too, including type-only and ambient imports.
const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const config = fileURLToPath(new URL("../packages/agent-core/tsconfig.json", import.meta.url));
const nativeCompilerPackage = import.meta.resolve(`@typescript/typescript-${process.platform}-${process.arch}/package.json`);
const libraryRoot = fileURLToPath(new URL("./lib/", nativeCompilerPackage));
const files = execFileSync(process.execPath, [compiler, "-p", config, "--listFilesOnly"], { encoding: "utf8" });
for (const file of files.trim().split(/\r?\n/)) {
  const local = relative(root, file);
  const library = relative(libraryRoot, file);
  const ownSource = !local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local);
  if (!ownSource && !/^lib\.(?:es\d+|esnext|decorators)[\w.]*\.d\.ts$/.test(library)) throw new Error(`Forbidden Core ambient dependency: ${file}`);
}
console.log("Core 依赖边界检查通过。");

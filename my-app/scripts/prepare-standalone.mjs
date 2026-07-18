import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

const appRoot = process.cwd();
const pkg = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8"));
const standaloneRoot = path.join(appRoot, ".next", "standalone", pkg.name);

async function copyRequiredDir(source, destination) {
  await stat(source);
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

await copyRequiredDir(path.join(appRoot, ".next", "static"), path.join(standaloneRoot, ".next", "static"));
await copyRequiredDir(path.join(appRoot, "public"), path.join(standaloneRoot, "public"));

console.log("Prepared standalone static assets.");

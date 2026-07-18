import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const result = spawnSync(
  process.execPath,
  ["scripts/desktop-build.mjs", "--local-unsigned", ...args],
  {
    cwd: appRoot,
    shell: false,
    stdio: "inherit",
    env: {
      ...process.env,
      LUNERY_LOCAL_UNSIGNED_BUILD: "1",
    },
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

import packageJson from "@/package.json";

/** Canonical product version from package.json — backups and diagnostics share this. */
export const APP_VERSION = packageJson.version;

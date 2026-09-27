import * as fs from "fs";
import * as path from "path";

const PREFERRED_SCRIPTS = ["dev", "start", "serve"] as const;

export function suggestCommand(folderPath: string): string {
  const pkgPath = path.join(folderPath, "package.json");
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts ?? {};
  } catch {
    return "";
  }

  const script = PREFERRED_SCRIPTS.find((name) => typeof scripts[name] === "string");
  if (!script) {
    return "";
  }

  const pm = detectPackageManager(folderPath);
  if (pm === "npm") {
    return `npm run ${script}`;
  }
  return `${pm} ${script}`;
}

function detectPackageManager(folderPath: string): "bun" | "pnpm" | "yarn" | "npm" {
  const has = (file: string) => fs.existsSync(path.join(folderPath, file));
  if (has("bun.lock") || has("bun.lockb")) {
    return "bun";
  }
  if (has("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (has("yarn.lock")) {
    return "yarn";
  }
  return "npm";
}

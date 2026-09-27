import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export type RunStatusKind =
  | "idle"
  | "starting"
  | "running"
  | "success"
  | "error"
  | "stopped";

export interface RunStatus {
  folderPath: string;
  folderName: string;
  sessionId: string;
  command: string;
  kind: RunStatusKind;
  exitCode?: number;
  updatedAt: number;
}

const ROOT = path.join(os.homedir(), ".project-runner");
const STATUS_DIR = path.join(ROOT, "status");
const STATUS_TTL_MS = 6 * 60 * 60 * 1000;

interface TrackedTerminal {
  folderPath: string;
  folderName: string;
  sessionId: string;
  command: string;
}

const tracked = new Map<vscode.Terminal, TrackedTerminal>();

export function ensureStatusDir(): void {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
}

export function folderKey(folderPath: string): string {
  const normalized = path.normalize(folderPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function markStatus(partial: Omit<RunStatus, "updatedAt"> & { updatedAt?: number }): void {
  ensureStatusDir();
  const status: RunStatus = {
    ...partial,
    updatedAt: partial.updatedAt ?? Date.now(),
  };
  writeAtomic(statusPath(status.folderPath), JSON.stringify(status));
}

export function readAllStatuses(): Map<string, RunStatus> {
  ensureStatusDir();
  const now = Date.now();
  const out = new Map<string, RunStatus>();

  for (const file of listJson(STATUS_DIR)) {
    const status = readJson<RunStatus>(file);
    if (!status?.folderPath || !status.kind) {
      continue;
    }
    if (now - status.updatedAt > STATUS_TTL_MS) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore races.
      }
      continue;
    }
    out.set(folderKey(status.folderPath), status);
  }

  return out;
}

export function trackTerminal(
  terminal: vscode.Terminal,
  info: TrackedTerminal
): void {
  tracked.set(terminal, info);
  markStatus({
    folderPath: info.folderPath,
    folderName: info.folderName,
    sessionId: info.sessionId,
    command: info.command,
    kind: "starting",
  });
}

export function startStatusTracker(): vscode.Disposable {
  const startSub = vscode.window.onDidStartTerminalShellExecution((event) => {
    const info = tracked.get(event.terminal);
    if (!info) {
      return;
    }
    markStatus({
      ...info,
      kind: "running",
    });
  });

  const endSub = vscode.window.onDidEndTerminalShellExecution((event) => {
    const info = tracked.get(event.terminal);
    if (!info) {
      return;
    }
    const exitCode = event.exitCode;
    const kind: RunStatusKind =
      exitCode === undefined ? "stopped" : exitCode === 0 ? "success" : "error";
    markStatus({
      ...info,
      kind,
      exitCode,
    });
  });

  const closeSub = vscode.window.onDidCloseTerminal((terminal) => {
    const info = tracked.get(terminal);
    if (!info) {
      return;
    }
    tracked.delete(terminal);
    const current = readAllStatuses().get(folderKey(info.folderPath));
    if (current && (current.kind === "starting" || current.kind === "running")) {
      markStatus({
        ...info,
        kind: "stopped",
      });
    }
  });

  return {
    dispose: () => {
      startSub.dispose();
      endSub.dispose();
      closeSub.dispose();
      tracked.clear();
    },
  };
}

function statusPath(folderPath: string): string {
  const key = folderKey(folderPath)
    .replace(/[:\\/]+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(STATUS_DIR, `${key}.json`);
}

function listJson(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The copy already landed.
    }
  }
}

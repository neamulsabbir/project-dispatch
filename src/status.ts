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

export function startStatusTracker(sessionId: string): vscode.Disposable {
  const startSub = vscode.window.onDidStartTerminalShellExecution((event) => {
    const command = event.execution.commandLine.value.trim();
    const info = resolveTerminal(event.terminal, event.execution.cwd, sessionId, command);
    if (!info) {
      return;
    }
    tracked.set(event.terminal, info);
    markStatus({
      ...info,
      kind: "running",
    });
  });

  const endSub = vscode.window.onDidEndTerminalShellExecution((event) => {
    const command = event.execution.commandLine.value.trim();
    const info = resolveTerminal(event.terminal, event.execution.cwd, sessionId, command);
    if (!info) {
      return;
    }
    const exitCode = event.exitCode;
    markStatus({
      ...info,
      kind: statusForExit(exitCode),
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

function resolveTerminal(
  terminal: vscode.Terminal,
  cwd: vscode.Uri | undefined,
  sessionId: string,
  command: string
): TrackedTerminal | undefined {
  const known = tracked.get(terminal);
  const folder = folderForCwd(cwd ?? terminal.shellIntegration?.cwd);
  if (known) {
    return {
      ...known,
      command: command || known.command,
    };
  }
  if (!folder || !command) {
    return undefined;
  }
  return {
    folderPath: folder.folderPath,
    folderName: folder.folderName,
    sessionId,
    command,
  };
}

function folderForCwd(cwd: vscode.Uri | undefined): { folderPath: string; folderName: string } | undefined {
  if (!cwd?.fsPath) {
    return undefined;
  }
  const target = folderKey(cwd.fsPath);
  let best: vscode.WorkspaceFolder | undefined;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const key = folderKey(folder.uri.fsPath);
    const prefix = key.endsWith(path.sep) ? key : `${key}${path.sep}`;
    if (target !== key && !target.startsWith(prefix)) {
      continue;
    }
    if (!best || folder.uri.fsPath.length > best.uri.fsPath.length) {
      best = folder;
    }
  }
  if (!best) {
    return undefined;
  }
  return {
    folderPath: best.uri.fsPath,
    folderName: best.name,
  };
}

function statusForExit(exitCode: number | undefined): RunStatusKind {
  if (exitCode === 0) {
    return "success";
  }
  if (
    exitCode === undefined ||
    exitCode === 130 ||
    exitCode === 143 ||
    exitCode === 3221225786
  ) {
    return "stopped";
  }
  return "error";
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

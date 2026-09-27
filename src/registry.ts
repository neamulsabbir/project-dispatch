import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { folderKey, readAllStatuses, type RunStatus } from "./status";
import { suggestCommand } from "./suggest";

export interface ProjectRow {
  sessionId: string;
  folderPath: string;
  folderName: string;
  windowLabel: string;
  appName: string;
  suggestedCommand: string;
  savedCommand: string;
  updatedAt: number;
  isCurrent: boolean;
  runStatus: RunStatus | null;
}

export interface RunRequest {
  id: string;
  targetSessionId: string;
  folderPath: string;
  folderName: string;
  command: string;
  action?: "run" | "stop" | "focus";
  createdAt: number;
}

interface InstanceFile {
  sessionId: string;
  windowLabel: string;
  appName: string;
  folders: Array<{
    name: string;
    path: string;
    suggestedCommand: string;
  }>;
  updatedAt: number;
}

const ROOT = path.join(os.homedir(), ".project-runner");
const INSTANCES = path.join(ROOT, "instances");
const INBOX = path.join(ROOT, "inbox");
const SAVED = path.join(ROOT, "saved-commands.json");

const ONLINE_MS = 7000;
const INSTANCE_TTL_MS = 30_000;
const REQUEST_TTL_MS = 60_000;

export function ensureBus(): void {
  fs.mkdirSync(INSTANCES, { recursive: true });
  fs.mkdirSync(INBOX, { recursive: true });
}

export function publishInstance(sessionId: string): void {
  ensureBus();
  const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    path: folder.uri.fsPath,
    suggestedCommand: suggestCommand(folder.uri.fsPath),
  }));

  const instance: InstanceFile = {
    sessionId,
    windowLabel: vscode.workspace.name || folders[0]?.name || "Untitled",
    appName: vscode.env.appName,
    folders,
    updatedAt: Date.now(),
  };

  writeAtomic(instancePath(sessionId), JSON.stringify(instance));
  sweepStale();
}

export function removeInstance(sessionId: string): void {
  try {
    fs.unlinkSync(instancePath(sessionId));
  } catch {
    // Already gone.
  }
}

export function listProjects(currentSessionId: string): ProjectRow[] {
  ensureBus();
  const saved = readSaved();
  const statuses = readAllStatuses();
  const now = Date.now();
  const rows: ProjectRow[] = [];

  for (const file of listJson(INSTANCES)) {
    const instance = readJson<InstanceFile>(file);
    if (!instance?.sessionId || !Array.isArray(instance.folders)) {
      continue;
    }
    if (now - instance.updatedAt > ONLINE_MS) {
      continue;
    }
    for (const folder of instance.folders) {
      if (!folder?.path) {
        continue;
      }
      rows.push({
        sessionId: instance.sessionId,
        folderPath: folder.path,
        folderName: folder.name || path.basename(folder.path),
        windowLabel: instance.windowLabel,
        appName: instance.appName || "VS Code",
        suggestedCommand: folder.suggestedCommand || "",
        savedCommand: saved[commandKey(folder.path)] || "",
        updatedAt: instance.updatedAt,
        isCurrent: instance.sessionId === currentSessionId,
        runStatus: statuses.get(folderKey(folder.path)) ?? null,
      });
    }
  }

  rows.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) {
      return a.isCurrent ? -1 : 1;
    }
    return a.folderName.localeCompare(b.folderName);
  });
  return rows;
}

export function isOnline(sessionId: string): boolean {
  const instance = readJson<InstanceFile>(instancePath(sessionId));
  return Boolean(instance && Date.now() - instance.updatedAt <= ONLINE_MS);
}

export function saveCommand(folderPath: string, command: string): void {
  ensureBus();
  const saved = readSaved();
  const key = commandKey(folderPath);
  const trimmed = command.trim();
  if (trimmed) {
    saved[key] = trimmed;
  } else {
    delete saved[key];
  }
  writeAtomic(SAVED, JSON.stringify(saved, null, 2));
}

export function enqueue(request: RunRequest): void {
  ensureBus();
  writeAtomic(path.join(INBOX, `${sanitize(request.id)}.json`), JSON.stringify(request));
}

export function drainInbox(sessionId: string): RunRequest[] {
  ensureBus();
  const mine: RunRequest[] = [];
  const now = Date.now();

  for (const file of listJson(INBOX)) {
    const request = readJson<RunRequest>(file);
    if (!request?.targetSessionId) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore races.
      }
      continue;
    }
    if (now - request.createdAt > REQUEST_TTL_MS) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore races.
      }
      continue;
    }
    if (request.targetSessionId !== sessionId) {
      continue;
    }
    try {
      fs.unlinkSync(file);
      mine.push(request);
    } catch {
      // Another poll took it.
    }
  }

  return mine;
}

export function startRegistry(sessionId: string): { publish: () => void; dispose: () => void } {
  const publish = () => publishInstance(sessionId);
  const timer = setInterval(publish, 2000);
  publish();
  return {
    publish,
    dispose: () => {
      clearInterval(timer);
      removeInstance(sessionId);
    },
  };
}

function sweepStale(): void {
  const now = Date.now();
  for (const file of listJson(INSTANCES)) {
    const instance = readJson<InstanceFile>(file);
    if (!instance || now - instance.updatedAt > INSTANCE_TTL_MS) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore races.
      }
    }
  }
}

function readSaved(): Record<string, string> {
  return readJson<Record<string, string>>(SAVED) ?? {};
}

function commandKey(folderPath: string): string {
  const normalized = path.normalize(folderPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function instancePath(sessionId: string): string {
  return path.join(INSTANCES, `${sanitize(sessionId)}.json`);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
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

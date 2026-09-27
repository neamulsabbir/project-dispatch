import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

export async function focusProject(options: {
  isCurrent: boolean;
  folderPath: string;
  folderName: string;
  windowLabel: string;
  appName: string;
}): Promise<boolean> {
  revealLocalTerminal(options.folderPath);

  if (options.isCurrent) {
    await vscode.commands.executeCommand("workbench.action.terminal.focus").then(
      () => undefined,
      () => undefined
    );
    return true;
  }

  if (process.platform === "win32") {
    return focusWindowsWindow(options);
  }

  return false;
}

export function revealLocalTerminal(folderPath: string): boolean {
  const name = `Project Dispatch · ${path.basename(folderPath)}`;
  const terminal = vscode.window.terminals.find((item) => item.name === name);
  if (!terminal) {
    return false;
  }
  terminal.show(true);
  return true;
}

async function focusWindowsWindow(options: {
  folderName: string;
  windowLabel: string;
  appName: string;
  folderPath: string;
}): Promise<boolean> {
  const processNames = processNamesForApp(options.appName);
  const hints = unique([
    options.folderName,
    options.windowLabel,
    basenameHint(options.folderPath),
  ]).filter(Boolean);

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ProjectRunnerFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@

$processNames = @(${processNames.map((name) => `'${escapePs(name)}'`).join(",")})
$hints = @(${hints.map((hint) => `'${escapePs(hint)}'`).join(",")})

$candidates = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and
  $processNames -contains $_.ProcessName
}

$match = $null
foreach ($hint in $hints) {
  $match = $candidates | Where-Object { $_.MainWindowTitle -like ("*" + $hint + "*") } | Select-Object -First 1
  if ($match) { break }
}

if (-not $match) {
  Write-Output "not-found"
  exit 0
}

$hwnd = $match.MainWindowHandle
if ([ProjectRunnerFocus]::IsIconic($hwnd)) {
  [void][ProjectRunnerFocus]::ShowWindowAsync($hwnd, 9)
} else {
  [void][ProjectRunnerFocus]::ShowWindowAsync($hwnd, 5)
}

$fg = [ProjectRunnerFocus]::GetForegroundWindow()
$fgThread = 0
$curThread = [ProjectRunnerFocus]::GetCurrentThreadId()
[void][ProjectRunnerFocus]::GetWindowThreadProcessId($fg, [ref]$fgThread)
$targetThread = 0
[void][ProjectRunnerFocus]::GetWindowThreadProcessId($hwnd, [ref]$targetThread)
if ($fgThread -ne $targetThread) {
  [void][ProjectRunnerFocus]::AttachThreadInput($curThread, $fgThread, $true)
  [void][ProjectRunnerFocus]::AttachThreadInput($curThread, $targetThread, $true)
}
[void][ProjectRunnerFocus]::SetForegroundWindow($hwnd)
if ($fgThread -ne $targetThread) {
  [void][ProjectRunnerFocus]::AttachThreadInput($curThread, $fgThread, $false)
  [void][ProjectRunnerFocus]::AttachThreadInput($curThread, $targetThread, $false)
}
Write-Output ("focused:" + $match.MainWindowTitle)
`;

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 5000 }
    );
    return String(stdout).includes("focused:");
  } catch {
    return false;
  }
}

function processNamesForApp(appName: string): string[] {
  const lower = appName.toLowerCase();
  if (lower.includes("cursor")) {
    return ["Cursor"];
  }
  if (lower.includes("insiders")) {
    return ["Code - Insiders", "CodeInsiders"];
  }
  return ["Code", "Code - Insiders", "Cursor"];
}

function basenameHint(folderPath: string): string {
  const parts = folderPath.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

function escapePs(value: string): string {
  return value.replace(/'/g, "''");
}

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
  const cli = cliForApp(options.appName);

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ProjectRunnerFocus {
  public static List<IntPtr> Hwnds = new List<IntPtr>();
  public static List<string> Titles = new List<string>();
  public static HashSet<uint> Pids = new HashSet<uint>();
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  public static bool Collect(IntPtr hWnd, IntPtr lParam) {
    if (!IsWindowVisible(hWnd)) return true;
    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    if (!Pids.Contains(pid)) return true;
    int len = GetWindowTextLength(hWnd);
    if (len <= 0) return true;
    var sb = new StringBuilder(len + 1);
    GetWindowText(hWnd, sb, sb.Capacity);
    string title = sb.ToString();
    if (string.IsNullOrWhiteSpace(title)) return true;
    Hwnds.Add(hWnd);
    Titles.Add(title);
    return true;
  }

  public static IntPtr Find(string[] hints) {
    Hwnds.Clear();
    Titles.Clear();
    EnumProc proc = Collect;
    EnumWindows(proc, IntPtr.Zero);
    GC.KeepAlive(proc);
    IntPtr best = IntPtr.Zero;
    int bestScore = -1;
    if (hints == null) return best;
    foreach (string hint in hints) {
      if (string.IsNullOrWhiteSpace(hint)) continue;
      for (int i = 0; i < Titles.Count; i++) {
        int index = Titles[i].IndexOf(hint, StringComparison.OrdinalIgnoreCase);
        if (index < 0) continue;
        bool leftOk = index == 0 || !char.IsLetterOrDigit(Titles[i][index - 1]);
        bool rightOk = index + hint.Length >= Titles[i].Length || !char.IsLetterOrDigit(Titles[i][index + hint.Length]);
        int score = hint.Length + (leftOk && rightOk ? 1000 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = Hwnds[i];
        }
      }
      if (bestScore >= 1000) return best;
    }
    return best;
  }
}
"@

$processNames = @(${processNames.map((name) => `'${escapePs(name)}'`).join(", ")})
$hints = @(${hints.map((hint) => `'${escapePs(hint)}'`).join(", ")})
[ProjectRunnerFocus]::Pids.Clear()
Get-Process | Where-Object { $processNames -contains $_.ProcessName } | ForEach-Object {
  [void][ProjectRunnerFocus]::Pids.Add([uint32]$_.Id)
}
$hwnd = [ProjectRunnerFocus]::Find([string[]]$hints)

if ($hwnd -eq [IntPtr]::Zero) {
  $cli = Get-Command '${escapePs(cli)}' -ErrorAction SilentlyContinue
  if ($cli) {
    & $cli.Source '${escapePs(options.folderPath)}'
    Write-Output "focused:cli"
    exit 0
  }
  Write-Output "not-found"
  exit 0
}

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
Write-Output "focused:window"
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
    return ["Code - Insiders"];
  }
  return ["Code"];
}

function cliForApp(appName: string): string {
  const lower = appName.toLowerCase();
  if (lower.includes("cursor")) {
    return "cursor";
  }
  if (lower.includes("insiders")) {
    return "code-insiders";
  }
  return "code";
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

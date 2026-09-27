import * as path from "path";
import * as vscode from "vscode";
import { drainInbox, type RunRequest } from "./registry";
import { revealLocalTerminal } from "./focus";
import { markStatus, trackTerminal } from "./status";

const SHELL_WAIT_MS = 3000;
const FALLBACK_DELAY_MS = 700;
const SPLIT_GAP_MS = 120;

export function startRunner(
  sessionId: string,
  output: vscode.OutputChannel
): vscode.Disposable {
  const timer = setInterval(() => {
    const requests = drainInbox(sessionId);
    if (!requests.length) {
      return;
    }

    const stops = requests.filter((request) => request.action === "stop");
    const focuses = requests.filter((request) => request.action === "focus");
    const runs = requests.filter(
      (request) => request.action !== "stop" && request.action !== "focus"
    );

    for (const request of stops) {
      output.appendLine(`Stop: ${request.folderPath}`);
      stopInFolder(request.folderPath, request.folderName, sessionId);
    }

    for (const request of focuses) {
      output.appendLine(`Focus: ${request.folderPath}`);
      revealLocalTerminal(request.folderPath);
      void vscode.commands.executeCommand("workbench.action.terminal.focus").then(
        () => undefined,
        () => undefined
      );
    }

    if (!runs.length) {
      return;
    }

    void runRequests(runs, output, sessionId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Failed batch: ${message}`);
      void vscode.window.showErrorMessage(`Project Runner failed: ${message}`);
    });
  }, 400);

  return {
    dispose: () => clearInterval(timer),
  };
}

export function stopInFolder(folderPath: string, folderName: string, sessionId: string): boolean {
  const name = terminalName(folderPath);
  const existing = vscode.window.terminals.find((terminal) => terminal.name === name);
  if (!existing) {
    markStatus({
      folderPath,
      folderName,
      sessionId,
      command: "",
      kind: "stopped",
    });
    return false;
  }

  existing.dispose();
  markStatus({
    folderPath,
    folderName,
    sessionId,
    command: "",
    kind: "stopped",
  });
  return true;
}

export function stopRequests(
  requests: Array<{ folderPath: string; folderName: string }>,
  sessionId: string,
  output: vscode.OutputChannel
): number {
  let stopped = 0;
  for (const request of requests) {
    output.appendLine(`Stop: ${request.folderPath}`);
    if (stopInFolder(request.folderPath, request.folderName, sessionId)) {
      stopped += 1;
    }
  }
  return stopped;
}

export async function runInFolder(
  folderPath: string,
  folderName: string,
  command: string,
  sessionId: string,
  options?: {
    parentTerminal?: vscode.Terminal;
    preserveFocus?: boolean;
  }
): Promise<vscode.Terminal> {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error("Empty command");
  }

  const name = terminalName(folderPath);
  const existing = vscode.window.terminals.find((terminal) => terminal.name === name);
  if (existing) {
    existing.dispose();
    await delay(150);
  }

  const createOptions: vscode.TerminalOptions = {
    name,
    cwd: folderPath,
  };
  if (options?.parentTerminal) {
    createOptions.location = { parentTerminal: options.parentTerminal };
  }

  const terminal = vscode.window.createTerminal(createOptions);
  trackTerminal(terminal, {
    folderPath,
    folderName,
    sessionId,
    command: trimmed,
  });
  terminal.show(options?.preserveFocus ?? false);

  const shell = await waitForShell(terminal);
  if (shell) {
    shell.executeCommand(trimmed);
    return terminal;
  }

  await delay(FALLBACK_DELAY_MS);
  terminal.sendText(trimmed);
  markStatus({
    folderPath,
    folderName,
    sessionId,
    command: trimmed,
    kind: "running",
  });
  return terminal;
}

export async function runRequests(
  requests: RunRequest[],
  output: vscode.OutputChannel,
  sessionId: string
): Promise<void> {
  if (!requests.length) {
    return;
  }

  const split = shouldSplit() && requests.length > 1;
  let parent: vscode.Terminal | undefined;

  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    output.appendLine(`Running: ${request.command} → ${request.folderPath}`);
    try {
      const terminal = await runInFolder(
        request.folderPath,
        request.folderName,
        request.command,
        sessionId,
        {
          parentTerminal: split ? parent : undefined,
          preserveFocus: index > 0,
        }
      );
      if (!parent) {
        parent = terminal;
      }
      if (split && index < requests.length - 1) {
        await delay(SPLIT_GAP_MS);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Failed: ${message}`);
      void vscode.window.showErrorMessage(
        `Project Runner failed in ${request.folderName}: ${message}`
      );
    }
  }

  parent?.show(false);
}

export function terminalName(folderPath: string): string {
  return `Project Runner · ${path.basename(folderPath)}`;
}

function shouldSplit(): boolean {
  return vscode.workspace.getConfiguration("projectRunner").get<boolean>("splitTerminals", true);
}

function waitForShell(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (shell: vscode.TerminalShellIntegration | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      subscription.dispose();
      resolve(shell);
    };

    const subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        finish(event.shellIntegration);
      }
    });

    const timeout = setTimeout(() => finish(terminal.shellIntegration), SHELL_WAIT_MS);

    if (terminal.shellIntegration) {
      finish(terminal.shellIntegration);
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

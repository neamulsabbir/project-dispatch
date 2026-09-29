import * as vscode from "vscode";
import { ProjectPanel } from "./panel";
import { startRegistry } from "./registry";
import { startRunner } from "./runner";
import { startStatusTracker } from "./status";

export function activate(context: vscode.ExtensionContext): void {
  const sessionId = vscode.env.sessionId;
  const output = vscode.window.createOutputChannel("Project Dispatch");
  const registry = startRegistry(sessionId);
  const panel = new ProjectPanel(sessionId, output);

  context.subscriptions.push(
    output,
    registry,
    startStatusTracker(sessionId),
    startRunner(sessionId, output),
    vscode.window.registerWebviewViewProvider("projectRunner.panel", panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      registry.publish();
      panel.refresh();
    }),
    vscode.commands.registerCommand("projectRunner.refresh", () => {
      registry.publish();
      panel.refresh();
    }),
    {
      dispose: () => panel.dispose(),
    }
  );
}

export function deactivate(): void {}

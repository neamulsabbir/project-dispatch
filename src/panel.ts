import * as crypto from "crypto";
import * as vscode from "vscode";
import { focusProject } from "./focus";
import { enqueue, isOnline, listProjects, saveCommand } from "./registry";
import { runRequests, stopRequests } from "./runner";

interface RunItem {
  sessionId: string;
  folderPath: string;
  folderName: string;
  command: string;
}

interface FocusItem {
  sessionId: string;
  folderPath: string;
  folderName: string;
  windowLabel: string;
  appName: string;
  isCurrent: boolean;
}

type WebviewMessage =
  | { type: "refresh" }
  | { type: "save"; folderPath: string; command: string }
  | { type: "run"; items: RunItem[] }
  | { type: "stop"; items: Array<{ sessionId: string; folderPath: string; folderName: string }> }
  | { type: "focus"; item: FocusItem };

export class ProjectPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly sessionId: string,
    private readonly output: vscode.OutputChannel
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.html = html(webviewView.webview.cspSource);
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.onMessage(message);
    });

    this.timer = setInterval(() => this.refresh(), 1000);
    webviewView.onDidDispose(() => {
      if (this.timer) {
        clearInterval(this.timer);
      }
    });
    this.refresh();
  }

  refresh(): void {
    this.view?.webview.postMessage({
      type: "projects",
      projects: listProjects(this.sessionId),
    });
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "refresh") {
      this.refresh();
      return;
    }

    if (message.type === "save") {
      saveCommand(message.folderPath, message.command);
      return;
    }

    if (message.type === "stop") {
      await this.handleStop(message.items ?? []);
      return;
    }

    if (message.type === "focus") {
      await this.handleFocus(message.item);
      return;
    }

    if (message.type !== "run" || this.busy) {
      return;
    }

    const items = (message.items ?? []).filter((item) => item.command?.trim() && item.folderPath);
    if (!items.length) {
      void vscode.window.showWarningMessage("Project Dispatch: select a project and enter a command.");
      return;
    }

    this.busy = true;
    try {
      const local: RunItem[] = [];
      const remote: RunItem[] = [];
      for (const item of items) {
        saveCommand(item.folderPath, item.command);
        if (item.sessionId === this.sessionId) {
          local.push(item);
        } else if (!isOnline(item.sessionId)) {
          void vscode.window.showWarningMessage(
            `Project Dispatch: ${item.folderName} is not responding. Keep that window open with this extension installed.`
          );
        } else {
          remote.push(item);
        }
      }

      for (const item of remote) {
        enqueue({
          id: crypto.randomUUID(),
          targetSessionId: item.sessionId,
          folderPath: item.folderPath,
          folderName: item.folderName,
          command: item.command.trim(),
          action: "run",
          createdAt: Date.now(),
        });
        this.output.appendLine(`Sent: ${item.command} → ${item.folderPath}`);
      }

      if (local.length) {
        await runRequests(
          local.map((item) => ({
            id: "local",
            targetSessionId: this.sessionId,
            folderPath: item.folderPath,
            folderName: item.folderName,
            command: item.command.trim(),
            action: "run" as const,
            createdAt: Date.now(),
          })),
          this.output,
          this.sessionId
        );
      }

      const parts: string[] = [];
      if (local.length) {
        parts.push(`${local.length} in this window`);
      }
      if (remote.length) {
        parts.push(`${remote.length} sent to other windows`);
      }
      if (parts.length) {
        void vscode.window.showInformationMessage(`Project Dispatch: ${parts.join(", ")}.`);
      }
      this.refresh();
    } finally {
      this.busy = false;
    }
  }

  private async handleStop(
    items: Array<{ sessionId: string; folderPath: string; folderName: string }>
  ): Promise<void> {
    if (this.busy) {
      return;
    }

    const selected = items.filter((item) => item.folderPath);
    if (!selected.length) {
      void vscode.window.showWarningMessage("Project Dispatch: select a project to stop.");
      return;
    }

    this.busy = true;
    try {
      const local: Array<{ folderPath: string; folderName: string }> = [];
      let remote = 0;

      for (const item of selected) {
        if (item.sessionId === this.sessionId) {
          local.push(item);
        } else if (!isOnline(item.sessionId)) {
          void vscode.window.showWarningMessage(
            `Project Dispatch: ${item.folderName} is not responding. Keep that window open with this extension installed.`
          );
        } else {
          enqueue({
            id: crypto.randomUUID(),
            targetSessionId: item.sessionId,
            folderPath: item.folderPath,
            folderName: item.folderName,
            command: "",
            action: "stop",
            createdAt: Date.now(),
          });
          this.output.appendLine(`Sent stop → ${item.folderPath}`);
          remote += 1;
        }
      }

      const stopped = stopRequests(local, this.sessionId, this.output);
      const parts: string[] = [];
      if (stopped) {
        parts.push(`stopped ${stopped}`);
      }
      if (remote) {
        parts.push(`stop sent to ${remote} other window project${remote === 1 ? "" : "s"}`);
      }
      if (parts.length) {
        void vscode.window.showInformationMessage(`Project Dispatch: ${parts.join(", ")}.`);
      } else {
        void vscode.window.showWarningMessage("Project Dispatch: no matching terminals were open.");
      }
      this.refresh();
    } finally {
      this.busy = false;
    }
  }

  private async handleFocus(item: FocusItem | undefined): Promise<void> {
    if (!item?.folderPath) {
      return;
    }

    if (!item.isCurrent && isOnline(item.sessionId)) {
      enqueue({
        id: crypto.randomUUID(),
        targetSessionId: item.sessionId,
        folderPath: item.folderPath,
        folderName: item.folderName,
        command: "",
        action: "focus",
        createdAt: Date.now(),
      });
    }

    const focused = await focusProject({
      isCurrent: item.isCurrent,
      folderPath: item.folderPath,
      folderName: item.folderName,
      windowLabel: item.windowLabel,
      appName: item.appName,
    });

    if (!item.isCurrent && !focused) {
      void vscode.window.showWarningMessage(
        `Project Dispatch: could not bring "${item.folderName}" to the front. Check that the window title contains the project name.`
      );
    }
  }
}

function html(cspSource: string): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Project Dispatch</title>
  <style>
    body {
      margin: 0;
      padding: 10px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 13px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 13px;
      font-weight: 600;
      margin: 0;
    }
    #status, .hint, .path, .app {
      color: var(--vscode-descriptionForeground);
    }
    #status, .hint { font-size: 11px; }
    .toolbar, .actions, .run-row {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
    }
    .run-row { margin-top: 4px; margin-bottom: 0; }
    .fill-input, .cmd {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 4px 6px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
    button {
      border: 0;
      cursor: pointer;
      padding: 4px 8px;
      white-space: nowrap;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.primary, button.danger {
      flex: 1;
      padding: 8px;
      color: var(--vscode-button-foreground);
    }
    button.primary {
      background: var(--vscode-button-background);
    }
    button.danger {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-errorForeground, #f85149);
    }
    button:hover { filter: brightness(1.08); }
    .row {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      padding: 8px;
      border-radius: 4px;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row input[type="checkbox"] { margin-top: 3px; }
    .body { min-width: 0; flex: 1; }
    .title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .name { font-weight: 600; }
    button.name-link {
      background: transparent;
      color: inherit;
      font: inherit;
      font-weight: 600;
      padding: 0;
      text-align: left;
      cursor: pointer;
      text-decoration: underline;
      text-decoration-color: transparent;
    }
    button.name-link:hover {
      filter: none;
      text-decoration-color: currentColor;
      color: var(--vscode-textLink-foreground);
    }
    .badge, .run-status {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .run-status .icon { font-size: 11px; line-height: 1; }
    .run-status.starting {
      background: color-mix(in srgb, #d29922 25%, transparent);
      color: #d29922;
    }
    .run-status.running {
      background: color-mix(in srgb, #3fb950 25%, transparent);
      color: #3fb950;
    }
    .run-status.success {
      background: color-mix(in srgb, #3fb950 18%, transparent);
      color: #3fb950;
    }
    .run-status.error {
      background: color-mix(in srgb, #f85149 22%, transparent);
      color: #f85149;
    }
    .run-status.stopped {
      background: color-mix(in srgb, #8b949e 22%, transparent);
      color: #8b949e;
    }
    .path, .app {
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cmd { margin-top: 6px; }
    .empty { line-height: 1.45; }
    .hint { line-height: 1.45; margin-top: 10px; }
  </style>
</head>
<body>
  <header>
    <h1>Project Dispatch</h1>
    <div id="status">Looking for windows…</div>
  </header>
  <div class="toolbar">
    <input id="fillInput" class="fill-input" type="text" placeholder="yarn dev" spellcheck="false" />
    <button id="fill" class="secondary" type="button">Apply</button>
  </div>
  <div class="actions">
    <button id="selectAll" class="secondary" type="button">Select all</button>
    <button id="refresh" class="secondary" type="button">Refresh</button>
  </div>
  <div id="list"></div>
  <div class="run-row">
    <button id="run" class="primary" type="button">Run selected</button>
    <button id="stop" class="danger" type="button">Stop selected</button>
  </div>
  <p class="hint">Click a project name to bring that VS Code/Cursor window to the front. Error projects show a warning icon. Stop closes their Project Dispatch terminals.</p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const list = document.getElementById("list");
    const status = document.getElementById("status");
    const state = vscode.getState() || { checked: {}, commands: {} };
    let projects = [];
    let signature = "";

    const rowId = (project) => project.sessionId + "|" + project.folderPath;
    const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));

    function statusLabel(runStatus) {
      if (!runStatus || !runStatus.kind || runStatus.kind === "idle") return "";
      const kind = runStatus.kind;
      const icons = {
        starting: "…",
        running: "●",
        success: "✓",
        error: "⚠",
        stopped: "■"
      };
      let text = kind;
      if (kind === "error" && typeof runStatus.exitCode === "number") {
        text = "error " + runStatus.exitCode;
      } else if (kind === "success") {
        text = "done";
      }
      const icon = icons[kind] ? '<span class="icon">' + icons[kind] + '</span>' : "";
      return '<span class="run-status ' + esc(kind) + '" title="' + esc(runStatus.command || kind) + '">'
        + icon + esc(text) + '</span>';
    }

    function projectSignature(project) {
      const rs = project.runStatus || {};
      return [
        rowId(project),
        project.suggestedCommand,
        project.isCurrent ? "1" : "0",
        rs.kind || "idle",
        rs.exitCode ?? "",
        rs.updatedAt || 0
      ].join(":");
    }

    function capture() {
      document.querySelectorAll("[data-row]").forEach((row) => {
        const id = row.dataset.row;
        state.checked[id] = row.querySelector('input[type="checkbox"]').checked;
        state.commands[id] = row.querySelector(".cmd").value;
      });
      vscode.setState(state);
    }

    function selectedProjects(requireCommand) {
      capture();
      const items = [];
      document.querySelectorAll(".row").forEach((row) => {
        if (!row.querySelector('input[type="checkbox"]').checked) return;
        const project = projects.find((item) => rowId(item) === row.dataset.row);
        if (!project) return;
        const command = row.querySelector(".cmd").value.trim();
        if (requireCommand && !command) return;
        items.push({
          sessionId: project.sessionId,
          folderPath: project.folderPath,
          folderName: project.folderName,
          command
        });
      });
      return items;
    }

    function render() {
      const active = document.activeElement;
      const activeRow = active && active.classList && active.classList.contains("cmd")
        ? active.closest("[data-row]")?.dataset.row
        : null;
      const activePos = activeRow && active.selectionStart;

      capture();
      if (!projects.length) {
        list.innerHTML = '<p class="empty">No open folder yet. Open a project folder in any window where Project Dispatch is installed.</p>';
        status.textContent = "0 projects";
        return;
      }
      const windows = new Set(projects.map((project) => project.sessionId)).size;
      status.textContent = projects.length + " project" + (projects.length === 1 ? "" : "s")
        + " · " + windows + " window" + (windows === 1 ? "" : "s");
      list.innerHTML = projects.map((project) => {
        const id = rowId(project);
        const checked = state.checked[id] ? "checked" : "";
        const command = state.commands[id] ?? (project.savedCommand || project.suggestedCommand || "");
        const badge = project.isCurrent ? '<span class="badge">this window</span>' : "";
        return '<div class="row" data-row="' + esc(id) + '">'
          + '<input type="checkbox" ' + checked + ' />'
          + '<div class="body">'
          + '<div class="title">'
          + '<button type="button" class="name-link" title="Bring this project window to the front">'
          + esc(project.folderName) + '</button>'
          + badge + statusLabel(project.runStatus) + '</div>'
          + '<div class="path" title="' + esc(project.folderPath) + '">' + esc(project.folderPath) + '</div>'
          + '<div class="app">' + esc(project.appName) + '</div>'
          + '<input class="cmd" type="text" value="' + esc(command) + '" placeholder="command" spellcheck="false" />'
          + '</div></div>';
      }).join("");

      document.querySelectorAll("[data-row]").forEach((row) => {
        const checkbox = row.querySelector('input[type="checkbox"]');
        const input = row.querySelector(".cmd");
        const nameLink = row.querySelector(".name-link");
        checkbox.addEventListener("change", () => {
          state.checked[row.dataset.row] = checkbox.checked;
          vscode.setState(state);
        });
        nameLink.addEventListener("click", (event) => {
          event.preventDefault();
          const project = projects.find((item) => rowId(item) === row.dataset.row);
          if (!project) return;
          vscode.postMessage({
            type: "focus",
            item: {
              sessionId: project.sessionId,
              folderPath: project.folderPath,
              folderName: project.folderName,
              windowLabel: project.windowLabel,
              appName: project.appName,
              isCurrent: project.isCurrent
            }
          });
        });
        input.addEventListener("change", () => {
          state.commands[row.dataset.row] = input.value;
          vscode.setState(state);
          const project = projects.find((item) => rowId(item) === row.dataset.row);
          if (project) {
            vscode.postMessage({ type: "save", folderPath: project.folderPath, command: input.value });
          }
        });
      });

      if (activeRow) {
        const row = document.querySelector('[data-row="' + CSS.escape(activeRow) + '"]');
        const input = row && row.querySelector(".cmd");
        if (input) {
          input.focus();
          if (typeof activePos === "number") {
            input.setSelectionRange(activePos, activePos);
          }
        }
      }
    }

    window.addEventListener("message", (event) => {
      if (event.data?.type !== "projects") return;
      projects = event.data.projects || [];
      const next = projects.map(projectSignature).join("|");
      if (next !== signature || !list.children.length) {
        signature = next;
        render();
      }
    });

    document.getElementById("refresh").addEventListener("click", () => {
      vscode.postMessage({ type: "refresh" });
    });

    document.getElementById("selectAll").addEventListener("click", () => {
      const boxes = [...document.querySelectorAll('.row input[type="checkbox"]')];
      const turnOn = boxes.some((box) => !box.checked);
      boxes.forEach((box) => {
        box.checked = turnOn;
        box.dispatchEvent(new Event("change"));
      });
    });

    document.getElementById("fill").addEventListener("click", () => {
      const value = document.getElementById("fillInput").value;
      document.querySelectorAll(".row").forEach((row) => {
        if (!row.querySelector('input[type="checkbox"]').checked) return;
        const input = row.querySelector(".cmd");
        input.value = value;
        input.dispatchEvent(new Event("change"));
      });
    });

    document.getElementById("run").addEventListener("click", () => {
      const items = selectedProjects(true);
      if (!items.length) {
        status.textContent = "Select a project and enter a command.";
        return;
      }
      vscode.postMessage({ type: "run", items });
    });

    document.getElementById("stop").addEventListener("click", () => {
      const items = selectedProjects(false);
      if (!items.length) {
        status.textContent = "Select a project to stop.";
        return;
      }
      vscode.postMessage({ type: "stop", items });
    });

    vscode.postMessage({ type: "refresh" });
  </script>
</body>
</html>`;
}

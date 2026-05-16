/**
 * Tool Approval Extension
 *
 * Prompts for confirmation before:
 *   - write tool calls (gating disabled — pi-tool-display handles display)
 *   - edit tool calls (gating disabled — pi-tool-display handles display)
 *   - any bash command not in the safe allowlist (or containing && / ;)
 *
 * Three options on every prompt:
 *   "Allow this"             → approve just this one call
 *   "Allow for this session" → approve this exact command for the rest of the session
 *   "Block"                  → deny
 *
 * Safe allowlist (no prompt):
 *   - Read-only file ops: cat, head, tail, wc, stat, file, diff, less, more, bat
 *   - File discovery: ls, pwd, whoami, date, uptime, df, du, ps, fd
 *   - Search: grep, rg
 *   - Data: jq, awk, tr, sort, uniq
 *   - Pipes/env: xargs, env, printenv, printf
 *   - Git (non-destructive): status, diff, log, branch, stash list, show,
 *       remote, tag, blame, ls-files, shortlog, describe, rev-parse, grep
 *   - System: cd, test, [, true, false, :, hostname, id, groups
 *   - Web skill proxy: curl / wget to http://web-skill:3000/ only
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  Input,
  matchesKey,
  Key,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@mariozechner/pi-tui";

/**
 * Result from the approval dialog.
 */
interface ApprovalResult {
  choice: "allow" | "allow-session" | "block";
  feedback: string;
}

/**
 * Inline approval dialog showing the command, options, and a feedback input
 * all on one screen so the user can see the command while typing feedback.
 */
class ApprovalDialog implements Component, Focusable {
  private command: string;
  private selectedIndex = 0;
  private input: Input;
  private inputFocused = false;
  private _focused = false;
  private done: (result: ApprovalResult) => void;
  private theme: { fg: (color: string, text: string) => string; bold: (text: string) => string };

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.inputFocused;
  }

  constructor(
    command: string,
    theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
    done: (result: ApprovalResult) => void,
  ) {
    this.command = command;
    this.theme = theme;
    this.done = done;
    this.input = new Input();
  }

  private options = ["Allow", "Allow for session", "Block"];

  render(width: number): string[] {
    const lines: string[] = [];

    // Top border
    lines.push(this.theme.fg("accent", "┌" + "─".repeat(width - 2) + "┐"));

    // Title
    lines.push(
      truncateToWidth(this.theme.fg("accent", this.theme.bold("  Approve bash command?")), width),
    );

    // Command preview (wrapped)
    const cmdLines = this.wrapText(this.command, width - 4);
    for (const line of cmdLines) {
      lines.push("  " + this.theme.fg("text", line));
    }

    // Spacer
    lines.push("");

    // Options — always show selection indicator even when input is focused
    for (let i = 0; i < this.options.length; i++) {
      const opt = this.options[i]!;
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? "> " : "  ";
      const color =
        i === 2
          ? "warning"
          : isSelected
            ? "accent"
            : "text";
      lines.push(truncateToWidth(prefix + this.theme.fg(color as any, opt), width));
    }

    // Feedback input
    const inputPrefix = this.inputFocused ? "> " : "  ";
    const inputLabel = this.inputFocused
      ? this.theme.fg("accent", inputPrefix + "Feedback: ")
      : this.theme.fg("dim", inputPrefix + "Feedback: ");
    const inputText = this.theme.fg("text", this.input.getValue());
    lines.push(truncateToWidth(inputLabel + inputText, width));

    // Help
    lines.push(
      truncateToWidth(
        this.theme.fg("dim", "  ↑↓ navigate  tab focus input  enter confirm  esc cancel"),
        width,
      ),
    );

    // Bottom border
    lines.push(this.theme.fg("accent", "└" + "─".repeat(width - 2) + "┘"));

    return lines;
  }

  private wrapText(text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    const paragraphs = text.split("\n");
    for (const para of paragraphs) {
      if (para.length <= maxWidth) {
        lines.push(para);
      } else {
        let remaining = para;
        while (remaining.length > 0) {
          if (remaining.length <= maxWidth) {
            lines.push(remaining);
            remaining = "";
          } else {
            // Try to break at a space
            let breakPoint = remaining.lastIndexOf(" ", maxWidth);
            if (breakPoint === -1) breakPoint = maxWidth;
            lines.push(remaining.slice(0, breakPoint));
            remaining = remaining.slice(breakPoint).trimStart();
          }
        }
      }
    }
    return lines;
  }

  handleInput(data: string): void {
    if (this.inputFocused) {
      // When input is focused, pass keys to the Input component
      // Enter confirms with current selection
      if (matchesKey(data, Key.enter)) {
        this.resolve();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.done({ choice: "block", feedback: "" });
        return;
      }
      if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.tab)) {
        this.inputFocused = false;
        this.input.focused = false;
        this.input.setValue("");
        return;
      }
      this.input.handleInput(data);
      return;
    }

    // Option navigation mode
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.inputFocused = true;
      this.input.focused = true;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.resolve();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done({ choice: "block", feedback: "" });
      return;
    }

    // Shortcuts: 1/2/3 for options
    if (data === "1") {
      this.selectedIndex = 0;
      this.resolve();
      return;
    }
    if (data === "2") {
      this.selectedIndex = 1;
      this.resolve();
      return;
    }
    if (data === "3") {
      this.selectedIndex = 2;
      this.resolve();
      return;
    }
  }

  private resolve(): void {
    const choice =
      this.selectedIndex === 0
        ? "allow"
        : this.selectedIndex === 1
          ? "allow-session"
          : "block";
    this.done({ choice, feedback: this.input.getValue().trim() });
  }

  invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
  // Track approved bash commands for this session (exact normalized command)
  const approvedBashCommands: Set<string> = new Set();
  // Store feedback for approved tool calls so we can inject it after execution
  const pendingFeedback = new Map<string, string>();

  const safeAllowlist: RegExp[] = [
    // Read-only file ops
    /^cat\b/,
    /^head\b/,
    /^tail\b/,
    /^wc\b/,
    /^stat\b/,
    /^file\b/,
    /^diff\b/,
    /^less\b/,
    /^more\b/,
    /^bat\b/,

    // File discovery / info
    /^ls\b/,
    /^pwd\b/,
    /^whoami\b/,
    /^date\b/,
    /^uptime\b/,
    /^df\b/,
    /^du\b/,
    /^ps\b/,
    /^fd\b/,

    // Search
    /^grep\b/,
    /^rg\b/,

    // Data processing
    /^jq\b/,
    /^awk\b/,
    /^tr\b/,
    /^sort\b/,
    /^uniq\b/,

    // Pipes / env
    /^xargs\b/,
    /^env\b/,
    /^printenv\b/,
    /^printf\b/,

    // Git (non-destructive)
    /^git\s+status\b/,
    /^git\s+diff\b/,
    /^git\s+log\b/,
    /^git\s+branch\b/,
    /^git\s+stash\s+list\b/,
    /^git\s+show\b/,
    /^git\s+remote\b/,
    /^git\s+tag\b/,
    /^git\s+blame\b/,
    /^git\s+ls-files\b/,
    /^git\s+shortlog\b/,
    /^git\s+describe\b/,
    /^git\s+rev-parse\b/,
    /^git\s+grep\b/,

    // System
    /^cd\b/,
    /^test\b/,
    /^\[\s/,
    /^true\b/,
    /^false\b/,
    /^:\s*$/,
    /^hostname\b/,
    /^id\b/,
    /^groups\b/,

    // Web skill proxy (the only approved egress path for web access)
    /^curl\b.*http:\/\/web-skill:3000\//,
    /^wget\b.*http:\/\/web-skill:3000\//,
  ];

  function isSafeCommand(cmd: string): boolean {
    // Reject command chaining with && or ; (e.g. "cd foo && rm -rf /")
    // Pipes | are allowed — they're common and safe with allowlisted commands
    if (cmd.includes("&&") || cmd.includes(";")) {
      return false;
    }
    return safeAllowlist.some((re) => re.test(cmd));
  }

  function getCommandKey(cmd: string): string {
    return cmd.trim().replace(/\s+/g, " ");
  }

  function buildApprovalMessage(toolName: string, input: unknown): string {
    if (toolName === "bash") {
      const command = (input as { command: string }).command;
      const preview =
        command.length > 300 ? command.slice(0, 300) + "\n... (truncated)" : command;
      return `Approve bash command?\n\n${preview}`;
    }

    return `Approve ${toolName}?`;
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("tool-approval", "Approval: enabled");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;

    // ---- write tool gating disabled ----
    // pi-tool-display handles write/edit rendering and diff previews.
    // Custom gating is delegated to the user's own script if needed.
    // if (toolName === "write") { ... }

    // ---- bash tool ----
    if (toolName === "bash") {
      const command = (event.input as { command: string }).command;

      if (isSafeCommand(command)) {
        return undefined;
      }

      const cmdKey = getCommandKey(command);
      if (approvedBashCommands.has(cmdKey)) {
        return undefined;
      }

      if (!ctx.hasUI) {
        return { block: true, reason: `Bash command blocked (no UI): ${command.slice(0, 100)}` };
      }

      const result = await ctx.ui.custom<ApprovalResult>((_tui, theme, _kb, done) => {
        return new ApprovalDialog(command, theme, done);
      });

      if (!result) return undefined;

      if (result.choice === "allow-session") {
        approvedBashCommands.add(cmdKey);
      }

      if (result.choice === "block") {
        const reason = result.feedback
          ? `Bash command blocked by user. Feedback: ${result.feedback}`
          : `Bash command blocked by user: ${command.slice(0, 100)}`;
        return { block: true, reason };
      }

      // Store feedback for approved calls so it's injected after execution
      if (result.feedback) {
        pendingFeedback.set(event.toolCallId, result.feedback);
      }

      return undefined;
    }

    return undefined;
  });

  // Inject user feedback into tool results so the agent can see it
  pi.on("tool_result", async (event, ctx) => {
    const feedback = pendingFeedback.get(event.toolCallId);
    if (!feedback) {
      return undefined;
    }
    pendingFeedback.delete(event.toolCallId);
    return {
      content: [
        ...event.content,
        { type: "text", text: `\nUser feedback: ${feedback}` },
      ],
    };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    approvedBashCommands.clear();
    pendingFeedback.clear();
    if (ctx.hasUI) {
      ctx.ui.setStatus("tool-approval", "Approval: enabled");
    }
  });
}

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

export default function (pi: ExtensionAPI) {
  // Track approved bash commands for this session (exact normalized command)
  const approvedBashCommands: Set<string> = new Set();

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

      const choice = await ctx.ui.select(
        buildApprovalMessage("bash", event.input),
        ["Allow this", "Allow for this session", "Block"],
      );

      if (choice === "Allow for this session") {
        approvedBashCommands.add(cmdKey);
      }

      return choice === "Block"
        ? { block: true, reason: `Bash command blocked by user: ${command.slice(0, 100)}` }
        : undefined;
    }

    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    approvedBashCommands.clear();
    if (ctx.hasUI) {
      ctx.ui.setStatus("tool-approval", "Approval: enabled");
    }
  });
}

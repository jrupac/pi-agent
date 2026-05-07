/**
 * Custom Footer Extension
 *
 * Replaces the default footer with:
 *   Line 1: ~/goliath (main) • Session  |  +123 -45
 *   Line 2: ↑12k ↓3.2k $0.005  ⚡1200/s  72.3%/128k  model-name
 *   Line 3: (green/red +/- lines when git diff has changes)
 *
 * Changes from default:
 *   - Removes cache read (R) from stats
 *   - Adds git diff +/- lines below stats
 *   - Adds token throughput (tokens/sec) to stats line
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "child_process";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ─── Token formatting ───────────────────────────────────────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

// ─── Git diff parsing ───────────────────────────────────────────────

function parseGitDiffShortstat(cwd: string): { files: number; ins: number; dels: number } | null {
  try {
    // Compare against HEAD so both staged and unstaged changes are counted.
    // Fall back to index-vs-worktree diff for repos with no commits yet.
    let stdout = "";
    const headResult = spawnSync(
      "git", ["diff", "HEAD", "--shortstat"],
      { cwd, encoding: "utf-8", maxBuffer: 1024 * 1024 },
    );
    if (headResult.status === 0 && headResult.stdout.trim()) {
      stdout = headResult.stdout;
    } else {
      const fallback = spawnSync(
        "git", ["diff", "--shortstat"],
        { cwd, encoding: "utf-8", maxBuffer: 1024 * 1024 },
      );
      if (fallback.status !== 0 || !fallback.stdout.trim()) return null;
      stdout = fallback.stdout;
    }

    const filesMatch = stdout.match(/(\d+) file/);
    const insMatch = stdout.match(/(\d+) insertion/);
    const delsMatch = stdout.match(/(\d+) deletion/);
    return {
      files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
      ins: insMatch ? parseInt(insMatch[1], 10) : 0,
      dels: delsMatch ? parseInt(delsMatch[1], 10) : 0,
    };
  } catch {
    return null;
  }
}

// ─── Thinking level display ─────────────────────────────────────────

function thinkingLevelLabel(level: string | undefined): string {
  if (!level || level === "off") return "thinking off";
  return level;
}

// ─── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let enabled = false;

  // Auto-enable custom footer on session start
  pi.on("session_start", async (_event, ctx) => {
    if (enabled) return; // Already enabled
    enabled = true;
    ctx.ui.setFooter((tui, theme, footerData) => {
      // Subscribe to git branch changes so footer refreshes
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      const interval = setInterval(() => tui.requestRender(), 3000);

      return {
        dispose: () => { clearInterval(interval); unsub(); },
        invalidate() {},
        render(width: number): string[] {
          // ── Token stats from session ──
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              totalInput += m.usage.input;
              totalOutput += m.usage.output;
              totalCacheWrite += m.usage.cacheWrite;
              totalCost += m.usage.cost.total;
            }
          }

          // ── Context usage ──
          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent = contextUsage?.percent !== null ? contextUsage.percent.toFixed(1) : "?";

          // ── Git branch + stats ──
          const branch = footerData.getGitBranch();
          const gitStats = parseGitDiffShortstat(ctx.sessionManager.getCwd());

          // ── Line 1: pwd + branch + session + git diff stats ──
          let pwd = ctx.sessionManager.getCwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) {
            pwd = `~${pwd.slice(home.length)}`;
          }
          const branchStr = branch ? ` (${branch})` : "";
          const sessionName = ctx.sessionManager.getSessionName();
          const sessionNameStr = sessionName ? ` • ${sessionName}` : "";

          // Git stats: colored "1M +17 -1" right-aligned on line 1
          const gitStatsParts: string[] = [];
          if (gitStats) {
            if (gitStats.files > 0) gitStatsParts.push(theme.fg("dim", `${gitStats.files}M`));
            if (gitStats.ins > 0) gitStatsParts.push(theme.fg("success", `+${formatTokens(gitStats.ins)}`));
            if (gitStats.dels > 0) gitStatsParts.push(theme.fg("error", `-${formatTokens(gitStats.dels)}`));
          }
          const gitStatsColored = gitStatsParts.join(" ");
          const gitStatsWidth = visibleWidth(gitStatsColored);

          // Build line 1: blue path + dim branch/session, colored right (git stats)
          const line1Left = `${pwd}${branchStr}${sessionNameStr}`;
          const line1PathColored = theme.fg("success", pwd);
          const line1RestColored = theme.fg("dim", `${branchStr}${sessionNameStr}`);
          const line1LeftColored = line1PathColored + line1RestColored;
          const line1LeftWidth = visibleWidth(line1Left);
          let line1: string;
          if (line1LeftWidth + (gitStatsWidth > 0 ? gitStatsWidth + 1 : 0) <= width) {
            const pad = " ".repeat(width - line1LeftWidth - gitStatsWidth);
            line1 = line1LeftColored + pad + gitStatsColored;
          } else {
            line1 = truncateToWidth(line1LeftColored, width, theme.fg("dim", "..."));
          }

          // ── Line 2: tokens + cost + throughput + context + model ──
          const statsParts: string[] = [];

          // Input/output tokens
          if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);

          // Cache write (R removed per user request)
          if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

          // Cost
          const usingSub = ctx.model
            ? ctx.modelRegistry.isUsingOAuth(ctx.model)
            : false;
          if (totalCost || usingSub) {
            statsParts.push(`$${totalCost.toFixed(3)}${usingSub ? " (sub)" : ""}`);
          }

          // Throughput: total output tokens / seconds since session start
          // We estimate session start from the first assistant message
          let sessionElapsedSec = 0;
          const entries = ctx.sessionManager.getBranch();
          for (const e of entries) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              if (m.timestamp) {
                const elapsedMs = Date.now() - m.timestamp;
                sessionElapsedSec = Math.max(sessionElapsedSec, elapsedMs / 1000);
              }
            }
          }
          if (totalOutput > 0 && sessionElapsedSec > 0) {
            const throughput = Math.round(totalOutput / sessionElapsedSec);
            statsParts.push(`⚡${formatTokens(throughput)}/s`);
          }

          // Context percentage (colorized)
          const autoIndicator = " (auto)";
          const contextDisplay = contextPercent === "?"
            ? `?/${formatTokens(contextWindow)}${autoIndicator}`
            : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
          let contextColor: string | undefined;
          if (contextPercentValue > 90) contextColor = "error";
          else if (contextPercentValue > 70) contextColor = "warning";
          statsParts.push(
            contextColor ? theme.fg(contextColor, contextDisplay) : contextDisplay,
          );

          let statsLeft = statsParts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }

          // Model name on the right
          const modelName = ctx.model?.id || "no-model";
          let rightSide = modelName;
          if (ctx.model?.reasoning) {
            const level = ctx.getThinkingLevel();
            rightSide = `${modelName} • ${thinkingLevelLabel(level)}`;
          }
          const rightSideWidth = visibleWidth(rightSide);
          const minPad = 2;
          let statsLine: string;
          if (statsLeftWidth + minPad + rightSideWidth <= width) {
            const pad = " ".repeat(width - statsLeftWidth - rightSideWidth);
            statsLine = statsLeft + pad + rightSide;
          } else {
            const available = width - statsLeftWidth - minPad;
            if (available > 0) {
              const truncatedRight = truncateToWidth(rightSide, available, "");
              const pad = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
              statsLine = statsLeft + pad + truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          // Dim the left stats, keep right side as-is
          const dimLeft = theme.fg("dim", statsLeft);
          const remainder = statsLine.slice(statsLeft.length);
          const dimRight = theme.fg("dim", remainder);

          // ── Build the lines ──
          return [
            line1,
            dimLeft + dimRight,
          ];
        },
      };
    });
    ctx.ui.notify("Custom footer enabled", "info");
  });

  pi.registerCommand("git-debug", {
    description: "Debug git diff stats used by the footer",
    handler: async (_args, ctx) => {
      const cwd = ctx.sessionManager.getCwd();
      const headResult = spawnSync("git", ["diff", "HEAD", "--shortstat"], {
        cwd, encoding: "utf-8", maxBuffer: 1024 * 1024,
      });
      const plainResult = spawnSync("git", ["diff", "--shortstat"], {
        cwd, encoding: "utf-8", maxBuffer: 1024 * 1024,
      });
      ctx.ui.notify(
        `cwd: ${cwd}\n` +
        `git diff HEAD: status=${headResult.status} stdout="${headResult.stdout.trim()}" stderr="${headResult.stderr?.trim()}"\n` +
        `git diff:      status=${plainResult.status} stdout="${plainResult.stdout.trim()}" stderr="${plainResult.stderr?.trim()}"`,
        "info",
      );
    },
  });

  pi.registerCommand("footer", {
    description: "Toggle custom footer (remove cache read, add git stats + throughput)",
    handler: async (_args, ctx) => {
      enabled = !enabled;

      if (enabled) {
        ctx.ui.setFooter((tui, theme, footerData) => {
          // Subscribe to git branch changes so footer refreshes
          const unsub = footerData.onBranchChange(() => tui.requestRender());
          const interval = setInterval(() => tui.requestRender(), 3000);

          return {
            dispose: () => { clearInterval(interval); unsub(); },
            invalidate() {},
            render(width: number): string[] {
              // ── Token stats from session ──
              let totalInput = 0;
              let totalOutput = 0;
              let totalCacheWrite = 0;
              let totalCost = 0;
              for (const e of ctx.sessionManager.getBranch()) {
                if (e.type === "message" && e.message.role === "assistant") {
                  const m = e.message as AssistantMessage;
                  totalInput += m.usage.input;
                  totalOutput += m.usage.output;
                  totalCacheWrite += m.usage.cacheWrite;
                  totalCost += m.usage.cost.total;
                }
              }

              // ── Context usage ──
              const contextUsage = ctx.getContextUsage();
              const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
              const contextPercentValue = contextUsage?.percent ?? 0;
              const contextPercent = contextUsage?.percent !== null ? contextUsage.percent.toFixed(1) : "?";

              // ── Git branch + stats ──
              const branch = footerData.getGitBranch();
              const gitStats = parseGitDiffShortstat(ctx.sessionManager.getCwd());

              // ── Line 1: pwd + branch + session + git diff stats ──
              let pwd = ctx.sessionManager.getCwd();
              const home = process.env.HOME || process.env.USERPROFILE;
              if (home && pwd.startsWith(home)) {
                pwd = `~${pwd.slice(home.length)}`;
              }
              const branchStr = branch ? ` (${branch})` : "";
              const sessionName = ctx.sessionManager.getSessionName();
              const sessionNameStr = sessionName ? ` • ${sessionName}` : "";

              // Git stats: colored "1M +17 -1" right-aligned on line 1
              const gitStatsParts: string[] = [];
              if (gitStats) {
                if (gitStats.files > 0) gitStatsParts.push(theme.fg("dim", `${gitStats.files}M`));
                if (gitStats.ins > 0) gitStatsParts.push(theme.fg("success", `+${formatTokens(gitStats.ins)}`));
                if (gitStats.dels > 0) gitStatsParts.push(theme.fg("error", `-${formatTokens(gitStats.dels)}`));
              }
              const gitStatsColored = gitStatsParts.join(" ");
              const gitStatsWidth = visibleWidth(gitStatsColored);

              // Build line 1: blue path + dim branch/session, colored right (git stats)
              const line1Left = `${pwd}${branchStr}${sessionNameStr}`;
              const line1PathColored = theme.fg("blue", pwd);
              const line1RestColored = theme.fg("dim", `${branchStr}${sessionNameStr}`);
              const line1LeftColored = line1PathColored + line1RestColored;
              const line1LeftWidth = visibleWidth(line1Left);
              let line1: string;
              if (line1LeftWidth + (gitStatsWidth > 0 ? gitStatsWidth + 1 : 0) <= width) {
                const pad = " ".repeat(width - line1LeftWidth - gitStatsWidth);
                line1 = line1LeftColored + pad + gitStatsColored;
              } else {
                line1 = truncateToWidth(line1LeftColored, width, theme.fg("dim", "..."));
              }

              // ── Line 2: tokens + cost + throughput + context + model ──
              const statsParts: string[] = [];

              // Input/output tokens
              if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
              if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);

              // Cache write (R removed per user request)
              if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

              // Cost
              const usingSub = ctx.model
                ? ctx.modelRegistry.isUsingOAuth(ctx.model)
                : false;
              if (totalCost || usingSub) {
                statsParts.push(`$${totalCost.toFixed(3)}${usingSub ? " (sub)" : ""}`);
              }

              // Throughput: total output tokens / seconds since session start
              // We estimate session start from the first assistant message
              let sessionElapsedSec = 0;
              const entries = ctx.sessionManager.getBranch();
              for (const e of entries) {
                if (e.type === "message" && e.message.role === "assistant") {
                  const m = e.message as AssistantMessage;
                  if (m.timestamp) {
                    const elapsedMs = Date.now() - m.timestamp;
                    sessionElapsedSec = Math.max(sessionElapsedSec, elapsedMs / 1000);
                  }
                }
              }
              if (totalOutput > 0 && sessionElapsedSec > 0) {
                const throughput = Math.round(totalOutput / sessionElapsedSec);
                statsParts.push(`⚡${formatTokens(throughput)}/s`);
              }

              // Context percentage (colorized)
              const autoIndicator = " (auto)";
              const contextDisplay = contextPercent === "?"
                ? `?/${formatTokens(contextWindow)}${autoIndicator}`
                : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
              let contextColor: string | undefined;
              if (contextPercentValue > 90) contextColor = "error";
              else if (contextPercentValue > 70) contextColor = "warning";
              statsParts.push(
                contextColor ? theme.fg(contextColor, contextDisplay) : contextDisplay,
              );

              let statsLeft = statsParts.join(" ");
              let statsLeftWidth = visibleWidth(statsLeft);
              if (statsLeftWidth > width) {
                statsLeft = truncateToWidth(statsLeft, width, "...");
                statsLeftWidth = visibleWidth(statsLeft);
              }

              // Model name on the right
              const modelName = ctx.model?.id || "no-model";
              let rightSide = modelName;
              if (ctx.model?.reasoning) {
                const level = ctx.getThinkingLevel();
                rightSide = `${modelName} • ${thinkingLevelLabel(level)}`;
              }
              const rightSideWidth = visibleWidth(rightSide);
              const minPad = 2;
              let statsLine: string;
              if (statsLeftWidth + minPad + rightSideWidth <= width) {
                const pad = " ".repeat(width - statsLeftWidth - rightSideWidth);
                statsLine = statsLeft + pad + rightSide;
              } else {
                const available = width - statsLeftWidth - minPad;
                if (available > 0) {
                  const truncatedRight = truncateToWidth(rightSide, available, "");
                  const pad = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
                  statsLine = statsLeft + pad + truncatedRight;
                } else {
                  statsLine = statsLeft;
                }
              }

              // Dim the left stats, keep right side as-is
              const dimLeft = theme.fg("dim", statsLeft);
              const remainder = statsLine.slice(statsLeft.length);
              const dimRight = theme.fg("dim", remainder);

              // ── Build the lines ──
              return [
                line1,
                dimLeft + dimRight,
              ];
            },
          };
        });
        ctx.ui.notify("Custom footer enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        enabled = false;
        ctx.ui.notify("Default footer restored", "info");
      }
    },
  });
}

/**
 * OpenCode Ralph Stop-Hook Plugin
 *
 * This plugin monitors opencode's session state and writes a signal file
 * when the session becomes idle (agent finishes processing). The ralph-uv
 * loop runner watches this signal file to detect iteration completion.
 *
 * Environment variables:
 *   RALPH_SIGNAL_FILE - Path to the JSON signal file to write on idle
 *   RALPH_SESSION_ID  - Optional session identifier for the signal payload
 *
 * Signal file format (JSON):
 *   { "event": "idle", "timestamp": "<ISO 8601>", "session_id": "<id>" }
 *
 * Log file: ~/.local/state/ralph-uv/plugin.log (always written for debugging)
 *
 * The plugin is loaded by opencode via the .opencode/plugins/ directory
 * mechanism. It hooks into the session lifecycle to detect when the agent
 * finishes processing a request.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** Signal payload written to the signal file on session idle. */
interface IdleSignal {
  event: "idle";
  timestamp: string;
  session_id: string;
}

/** Plugin configuration from environment. */
interface PluginConfig {
  signalFile: string;
  sessionId: string;
  logFile: string;
}

/**
 * Read plugin configuration from environment variables.
 * Returns null if RALPH_SIGNAL_FILE is not set (plugin is a no-op).
 */
function getConfig(): PluginConfig | null {
  const signalFile = process.env.RALPH_SIGNAL_FILE;
  if (!signalFile) {
    return null;
  }

  const logDir = path.join(os.homedir(), ".local", "state", "ralph-uv");
  fs.mkdirSync(logDir, { recursive: true });

  return {
    signalFile,
    sessionId: process.env.RALPH_SESSION_ID || "unknown",
    logFile: path.join(logDir, "plugin.log"),
  };
}

/**
 * Append a timestamped log entry to the plugin log file.
 */
function log(config: PluginConfig, level: string, message: string): void {
  const timestamp = new Date().toISOString();
  const entry = `${timestamp} ${level} [ralph-hook] ${message}\n`;
  try {
    fs.appendFileSync(config.logFile, entry);
  } catch {
    // Best-effort logging
  }
}

/**
 * Write the idle signal to the configured signal file.
 * Creates parent directories if they don't exist.
 * Writes atomically (write to temp + rename) to prevent partial reads.
 */
function writeSignal(config: PluginConfig): void {
  const signal: IdleSignal = {
    event: "idle",
    timestamp: new Date().toISOString(),
    session_id: config.sessionId,
  };

  const content = JSON.stringify(signal, null, 2) + "\n";
  const dir = path.dirname(config.signalFile);

  // Ensure directory exists
  fs.mkdirSync(dir, { recursive: true });

  // Write atomically: temp file + rename
  const tmpFile = config.signalFile + ".tmp";
  fs.writeFileSync(tmpFile, content, { mode: 0o644 });
  fs.renameSync(tmpFile, config.signalFile);
}

/**
 * OpenCode Plugin Entry Point
 *
 * Uses the opencode plugin API:
 * - Plugin is an async function that receives context
 * - Returns an object with hook handlers
 * - The `event` hook receives all opencode events
 * - We listen for `session.idle` to signal completion to ralph-uv
 *
 * Plugin lifecycle:
 * 1. opencode loads the plugin on startup
 * 2. Plugin registers an event handler and tracks the root session ID
 * 3. Subagent idle events (e.g. @explore) are ignored
 * 4. When the ROOT session goes idle, plugin writes the signal file
 * 5. ralph-uv detects the signal file and terminates the process
 */
export const RalphHook = async (ctx: any) => {
  const config = getConfig();
  if (!config) {
    // RALPH_SIGNAL_FILE not set - plugin is a no-op
    // This allows the plugin to be installed globally without side effects
    return {};
  }

  log(config, "INFO", `Plugin loaded, signal_file=${config.signalFile}`);

  // Track the root session ID (the first session created without a parentID).
  // Subagents (e.g. @explore) have a parentID and their idle events must be
  // ignored — only the root session going idle means the task is complete.
  let rootSessionId: string | null = null;

  return {
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      // Log session lifecycle events for debugging
      if (
        event.type === "session.idle" ||
        event.type === "session.status" ||
        event.type === "session.error" ||
        event.type === "session.created"
      ) {
        const props = event.properties
          ? JSON.stringify(event.properties)
          : "";
        log(config, "INFO", `event: ${event.type} ${props}`);
      }

      // Track root session: first session.created without a parentID
      if (event.type === "session.created" && event.properties?.info) {
        const info = event.properties.info;
        if (!info.parentID && !rootSessionId) {
          rootSessionId = info.id;
          log(config, "INFO", `Root session identified: ${rootSessionId}`);
        }
      }

      if (event.type === "session.idle") {
        const idleSessionId = event.properties?.sessionID;

        // Only signal when the ROOT session goes idle, not subagents
        if (rootSessionId && idleSessionId !== rootSessionId) {
          log(
            config,
            "INFO",
            `Ignoring idle from subagent session ${idleSessionId} (root=${rootSessionId})`,
          );
          return;
        }

        try {
          writeSignal(config);
          log(
            config,
            "INFO",
            `Signal written to ${config.signalFile} (root session ${idleSessionId} is idle)`,
          );
        } catch (err) {
          log(
            config,
            "ERROR",
            `Failed to write signal: ${err}`,
          );
        }
      }
    },
  };
};

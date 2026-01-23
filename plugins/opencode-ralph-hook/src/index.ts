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
 * The plugin is loaded by opencode via the .opencode/plugins/ directory
 * mechanism. It hooks into the session lifecycle to detect when the agent
 * finishes processing a request.
 */

import * as fs from "fs";
import * as path from "path";

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

  return {
    signalFile,
    sessionId: process.env.RALPH_SESSION_ID || "unknown",
  };
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
 * This is the plugin interface that opencode loads. The plugin registers
 * an event handler for the session.idle event. When fired, it writes
 * the signal file that ralph-uv is watching.
 *
 * Plugin lifecycle:
 * 1. opencode loads the plugin on startup
 * 2. Plugin registers for session.idle events
 * 3. When agent finishes processing, opencode fires session.idle
 * 4. Plugin writes the signal file
 * 5. ralph-uv detects the signal file change via inotify and proceeds
 */
export interface OpenCodePlugin {
  name: string;
  version: string;
  init: (api: OpenCodePluginAPI) => void;
}

/** OpenCode Plugin API surface (subset relevant to this plugin). */
export interface OpenCodePluginAPI {
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  getSessionId(): string;
}

/**
 * The plugin instance exported for opencode to load.
 */
const plugin: OpenCodePlugin = {
  name: "ralph-hook",
  version: "1.0.0",

  init(api: OpenCodePluginAPI): void {
    const config = getConfig();
    if (!config) {
      // RALPH_SIGNAL_FILE not set - plugin is a no-op
      // This allows the plugin to be installed globally without side effects
      return;
    }

    // Update session ID from API if available
    try {
      const apiSessionId = api.getSessionId();
      if (apiSessionId) {
        config.sessionId = apiSessionId;
      }
    } catch {
      // API may not support getSessionId yet - use env var fallback
    }

    // Register for session.idle event
    api.on("session.idle", () => {
      try {
        writeSignal(config);
      } catch (err) {
        // Silently fail - don't crash opencode if signal write fails
        // ralph-uv has a fallback (process exit detection)
        if (process.env.RALPH_DEBUG) {
          console.error("[ralph-hook] Failed to write signal:", err);
        }
      }
    });
  },
};

export default plugin;

// Also export as named export for CommonJS require compatibility
module.exports = plugin;

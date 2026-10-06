import {
  getAgentDir, VERSION,
  type ExtensionAPI, type ExtensionContext, type ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type Config } from "./config.js";
import { OtlpExporter } from "./exporter.js";
import { EXTENSION_VERSION } from "./otlp.js";
import { CHECKPOINT_TYPE, Recorder, type Checkpoint } from "./recorder.js";
import { readSettings, settingsPath, withSettings } from "./settings.js";
import { runSetup } from "./setup.js";

export default function piOtel(pi: ExtensionAPI): void {
  let exporter: OtlpExporter | undefined;
  let recorder: Recorder | undefined;
  let config: Config | undefined;
  let savedSequence = -1;

  pi.registerFlag("otel-disable", { description: "Disable pi-otel for this process", type: "boolean", default: false });
  pi.registerFlag("otel-no-content", {
    description: "Export usage/events without prompts, conversations, payloads or images",
    type: "boolean", default: false,
  });

  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(`[pi-otel] ${message}`, level);
    else console.error(`[pi-otel] ${message}`); // Never pollute RPC/JSON stdout.
  }

  function checkpoint(ctx: ExtensionContext): void {
    if (!recorder || !exporter) return;
    recorder.scan(ctx.sessionManager.getBranch());
    const state = recorder.checkpoint();
    if (state.sequence === savedSequence) return;
    // A checkpoint must not suppress replay of records that were never persisted.
    exporter.persist();
    pi.appendEntry(CHECKPOINT_TYPE, state);
    savedSequence = state.sequence;
  }

  pi.on("session_start", async (event, ctx) => {
    await exporter?.close();
    exporter = undefined;
    recorder = undefined;
    config = undefined;
    savedSequence = -1;
    ctx.ui.setStatus("pi-otel", undefined);
    if (pi.getFlag("otel-disable")) return;
    try {
      const settings = readSettings(settingsPath(getAgentDir()));
      config = loadConfig({
        ...withSettings(process.env, settings),
        ...(pi.getFlag("otel-no-content") ? { PI_OTEL_CAPTURE_CONTENT: "false" } : {}),
      }, getAgentDir());
      if (!config) {
        if (settings.enabled !== false && process.env.PI_OTEL_ENABLED?.trim().toLowerCase() !== "false") {
          ctx.ui.setStatus("pi-otel", "OTEL · not configured (/otel setup)");
        }
        return;
      }
      const checkpoints = ctx.sessionManager.getEntries().flatMap((entry) =>
        entry.type === "custom" && entry.customType === CHECKPOINT_TYPE && entry.data
          ? [entry.data as Checkpoint] : []);
      exporter = new OtlpExporter(config, {
        "service.name": config.serviceName,
        "service.version": EXTENSION_VERSION,
        "app.version": VERSION,
      }, (message) => notify(ctx, message, "warning"));
      recorder = new Recorder(config, ctx.sessionManager.getSessionId(),
        (record) => exporter?.enqueue(record), {
          "app.version": VERSION,
          "pi.mode": ctx.mode,
          "terminal.type": ctx.mode === "tui" ? "interactive" : "non-interactive",
          "pi.cwd": config.captureContent ? ctx.cwd : undefined,
          "pi.session.file": config.captureContent ? ctx.sessionManager.getSessionFile() : undefined,
          "pi.session.parent": config.captureContent ? ctx.sessionManager.getHeader()?.parentSession : undefined,
          "pi.content.captured": config.captureContent,
        }, checkpoints);
      notify(ctx, config.captureContent
        ? "Full-content telemetry enabled: prompts, conversations, system instructions, tool output and images will be sent."
        : "Telemetry enabled without conversation content.", "warning");
      ctx.ui.setStatus("pi-otel", config.captureContent ? "OTEL · full content" : "OTEL · metadata");
      recorder.history(ctx.sessionManager.getBranch());
      recorder.emit("plugin_loaded", {
        plugin_name: "pi-otel", plugin_version: EXTENSION_VERSION,
        "pi.event.name": "session_start", "pi.session.reason": event.reason,
      });
      // Retain all raw branches and metadata in a snapshot; only the active branch is
      // replayed as chat messages, so abandoned alternatives do not mingle in the chat.
      recorder.hook("session_snapshot", config.captureContent ? {
        header: ctx.sessionManager.getHeader(),
        leafId: ctx.sessionManager.getLeafId(),
        entries: ctx.sessionManager.getEntries().filter((entry) =>
          !(entry.type === "custom" && entry.customType === CHECKPOINT_TYPE)),
        systemPrompt: ctx.getSystemPrompt(),
        tools: pi.getAllTools(),
      } : undefined);
      checkpoint(ctx);
    } catch (error) {
      // Native URL/header errors may echo credentials. Show only our own validation messages.
      const message = error instanceof Error && !(error instanceof TypeError)
        ? error.message : "Invalid OTLP configuration or local outbox; check the configured values";
      notify(ctx, message, "error");
      await exporter?.close().catch(() => {});
      exporter = undefined;
      recorder = undefined;
      ctx.ui.setStatus("pi-otel", "OTEL · disabled (error)");
    }
  });

  // Observe only session-bound events. In particular, registering mcp_servers_change
  // would claim ownership of MCP connections; a telemetry observer must not do that.
  const events: ExtensionEvent["type"][] = [
    "session_info_changed", "session_before_switch", "session_before_fork",
    "session_before_compact", "session_compact", "session_compact_failed",
    "session_before_tree", "session_tree",
    "input", "user_bash", "before_agent_start", "agent_start", "agent_end",
    "agent_before_settle", "agent_settled", "ui_prompt_start", "ui_prompt_end",
    "turn_start", "turn_end", "message_start", "message_update", "message_end",
    "context", "context_with_system", "before_provider_request", "before_provider_headers",
    "after_provider_response", "provider_stream_event", "tool_call", "tool_result",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "model_select", "thinking_level_select", "cache_warming_decision",
  ];
  // ExtensionAPI uses literal overloads; this union adapter keeps the handler's
  // discriminated-union type while observing events without returning transformations.
  const observe = pi.on.bind(pi) as (
    event: ExtensionEvent["type"], handler: (event: ExtensionEvent, ctx: ExtensionContext) => void,
  ) => () => void;
  for (const name of events) {
    observe(name, (event, ctx) => {
      if (!recorder) return;
      try {
        recorder.event(event);
        if (["turn_end", "agent_settled", "session_compact", "session_tree"].includes(event.type)) {
          if (event.type === "session_tree") recorder.history(ctx.sessionManager.getBranch());
          checkpoint(ctx);
        }
      } catch {
        // tool_call failures block tools in pi. Export failures must never do so.
        notify(ctx, "Telemetry capture failed; check local outbox permissions and free space", "warning");
      }
      // Always undefined: never replace provider payloads, messages or tool results.
    });
  }

  pi.on("session_shutdown", async (event, ctx) => {
    try {
      recorder?.event(event);
      checkpoint(ctx);
    } catch {
      notify(ctx, "Could not checkpoint telemetry; inspect the local outbox", "warning");
    } finally {
      try { await exporter?.close(); }
      catch { notify(ctx, "Could not finish telemetry shutdown; inspect the local outbox", "warning"); }
      recorder = undefined;
      exporter = undefined;
      ctx.ui.setStatus("pi-otel", undefined);
    }
  });

  pi.registerCommand("otel", {
    description: "Telemetry setup, status or flush: /otel [setup|status|flush]",
    getArgumentCompletions: (prefix) => ["setup", "status", "flush"]
      .filter((value) => value.startsWith(prefix.trim()))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (!["setup", "status", "flush"].includes(command)) {
        notify(ctx, "Usage: /otel [setup|status|flush]", "warning");
        return;
      }
      if (command === "setup") {
        const path = settingsPath(getAgentDir());
        if (!ctx.hasUI) {
          notify(ctx, `Interactive setup needs the TUI; edit ${path} or use environment variables.`, "warning");
          return;
        }
        try {
          if (!(await runSetup(ctx, readSettings(path), path, process.env, getAgentDir()))) return;
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : "Could not save settings", "error");
          return;
        }
        notify(ctx, `Settings saved to ${path}; reloading.`);
        await ctx.reload();
        return;
      }
      if (!exporter || !config) {
        notify(ctx, "Disabled. Run /otel setup to configure the endpoint and token.");
        return;
      }
      try {
        const status = command === "flush" ? await exporter.flush() : exporter.status();
        notify(ctx, `${config.serviceName} · ${config.captureContent ? "full content" : "metadata"}` +
          ` · ${status.acceptedRecords} accepted · ${status.queuedRecords} pending` +
          (status.lastError ? ` · ${status.lastError}` : ""), status.lastError ? "warning" : "info");
      } catch {
        notify(ctx, "Could not persist or flush telemetry", "error");
      }
    },
  });
}

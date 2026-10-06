import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import { json, logRecord, textContent, type Attributes, type EventName, type LogRecord } from "./otlp.js";

export const CHECKPOINT_TYPE = "pi-otel.checkpoint.v1";
export interface Checkpoint {
  sessionId: string;
  destinationId: string;
  sequence: number;
  seenMessages: string[];
  seenEntries: string[];
}
interface Request { id: string; started: number; firstToken?: number; attempt: number }

export function messageKey(message: AgentMessage): string {
  return createHash("sha256").update(json(message)).digest("hex");
}

function safeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key, /authorization|cookie|api[-_]?key|token|secret|credential/i.test(key) ? "[REDACTED]" : value,
  ]));
}

export class Recorder {
  private sequence = 0;
  private seenMessages = new Set<string>();
  private seenEntries = new Set<string>();
  private promptId?: string;
  private request?: Request;
  private tools = new Map<string, { started: number; ended?: number; requestId?: string; promptId?: string }>();

  constructor(
    private config: Config,
    private sessionId: string,
    private emitRecord: (record: LogRecord) => void,
    private metadata: Attributes,
    checkpoints: Checkpoint[] = [],
    private now: () => number = Date.now,
  ) {
    // Sequence is session-wide, not branch-relative. Ignore checkpoints copied by /fork.
    for (const checkpoint of checkpoints) {
      if (checkpoint.sessionId !== sessionId || checkpoint.destinationId !== config.destinationId) continue;
      this.sequence = Math.max(this.sequence, checkpoint.sequence);
      for (const key of checkpoint.seenMessages) this.seenMessages.add(key);
      for (const key of checkpoint.seenEntries ?? []) this.seenEntries.add(key);
    }
  }

  checkpoint(): Checkpoint {
    return {
      sessionId: this.sessionId, destinationId: this.config.destinationId, sequence: this.sequence,
      seenMessages: [...this.seenMessages], seenEntries: [...this.seenEntries],
    };
  }

  emit(name: EventName, values: Attributes = {}, timestamp = this.now()): void {
    this.emitRecord(logRecord(name, {
      ...this.metadata,
      "session.id": this.sessionId,
      "user.email": this.config.userEmail,
      "prompt.id": this.promptId,
      request_id: this.request?.id,
      "event.timestamp": new Date(timestamp).toISOString(),
      "event.sequence": ++this.sequence,
      "event.name": name,
      ...values,
    }, timestamp));
  }

  hook(name: string, value: unknown, phase: "start" | "complete" = "complete", values: Attributes = {}): void {
    this.emit(phase === "start" ? "hook_execution_start" : "hook_execution_complete", {
      hook_name: `pi:${name}`,
      "pi.event.name": name,
      "pi.event.json": this.config.captureContent ? json(value) : undefined,
      ...values,
    });
  }

  /** Replays the full raw active branch, including history preceding compaction. */
  history(entries: SessionEntry[], replay = this.config.replayHistory): void {
    this.promptId = undefined;
    this.request = undefined;
    for (const entry of entries) {
      if (entry.type === "message") {
        if (entry.message.role === "user") this.promptId = this.id("prompt", messageKey(entry.message));
        if (replay) this.message(entry.message, true, entry.id, entry.parentId ?? undefined);
      } else if (replay && !(entry.type === "custom" && entry.customType === CHECKPOINT_TYPE)) {
        this.entry(entry);
      }
    }
  }

  private id(kind: string, key: string): string {
    return `${kind}-${createHash("sha256").update(`${this.sessionId}:${key}`).digest("hex").slice(0, 32)}`;
  }

  message(message: AgentMessage, historical = false, entryId?: string, parentId?: string): void {
    const key = messageKey(message);
    if (message.role === "user") this.promptId = this.id("prompt", key);
    if (this.seenMessages.has(key)) return;
    const timestamp = historical ? message.timestamp : this.now();
    const common: Attributes = {
      "pi.event.name": "message_end",
      "pi.message.role": message.role,
      "pi.message.json": this.config.captureContent ? json(message) : undefined,
      "pi.history": historical,
      "pi.entry.id": entryId,
      "pi.entry.parent_id": parentId,
    };
    if (message.role === "user") {
      this.emit("user_prompt", {
        ...common,
        prompt: this.config.captureContent ? textContent(message.content) : undefined,
        "pi.content.captured": this.config.captureContent,
      }, timestamp);
    } else if (message.role === "assistant") {
      const requestId = historical ? this.id("request", key) : this.request?.id || this.id("request", key);
      const response = textContent(message.content);
      const model = {
        ...common,
        request_id: requestId,
        model: message.responseModel || message.model,
        "pi.model.selected": message.model,
        "pi.provider": message.provider,
        "pi.api": message.api,
        "pi.response.id": message.responseId,
        "pi.stop_reason": message.stopReason,
        "pi.thinking_level": message.thinkingLevel,
      };
      // Tool-only/thinking-only messages remain in pi.message.json; no empty chat bubble.
      if (response) this.emit("assistant_response", {
        ...model, response: this.config.captureContent ? response : undefined,
      }, timestamp);
      else this.hook("assistant_message", this.config.captureContent ? message : undefined, "complete", model);
      const usage = message.usage;
      this.emit("api_request", {
        ...model,
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_tokens: usage.cacheRead,
        "cache_write_tokens": usage.cacheWrite,
        "pi.reasoning_tokens": usage.reasoning,
        "pi.total_tokens": usage.totalTokens,
        cost_usd: usage.cost.total,
        duration_ms: !historical && this.request ? this.now() - this.request.started : undefined,
        ttft_ms: !historical && this.request?.firstToken !== undefined
          ? this.request.firstToken - this.request.started : undefined,
      }, timestamp);
      if (message.stopReason === "error" || message.stopReason === "aborted") this.emit("api_error", {
        ...model,
        error: this.config.captureContent ? message.errorMessage : undefined,
        "pi.aborted": message.stopReason === "aborted",
      }, timestamp);
    } else if (message.role === "toolResult") {
      const tool = historical ? undefined : this.tools.get(message.toolCallId);
      this.emit("tool_result", {
        ...common, tool_name: message.toolName, tool_call_id: message.toolCallId,
        "prompt.id": tool?.promptId ?? this.promptId,
        request_id: tool?.requestId ?? this.request?.id,
        duration_ms: tool ? (tool.ended ?? this.now()) - tool.started : undefined,
        success: !message.isError, "pi.tool.phase": "message",
        "pi.tool.output": this.config.captureContent ? textContent(message.content) : undefined,
      }, timestamp);
      this.tools.delete(message.toolCallId);
      // Top-level tool usage already includes nested tool/model work. Do not count
      // tool_result hooks too: that would bill the same nested usage twice.
      if (message.usage) this.emit("api_request", {
        request_id: this.id("tool-request", key),
        input_tokens: message.usage.input, output_tokens: message.usage.output,
        cache_read_tokens: message.usage.cacheRead, cache_write_tokens: message.usage.cacheWrite,
        cost_usd: message.usage.cost.total,
        query_source: "sdk", "pi.usage.kind": "tool", tool_name: message.toolName,
      }, timestamp);
    } else {
      this.hook(`${message.role}_message`, message, "complete", common);
    }
    this.seenMessages.add(key);
  }

  entry(entry: SessionEntry): void {
    if (entry.type === "custom" && entry.customType === CHECKPOINT_TYPE) return;
    if (this.seenEntries.has(entry.id)) return;
    this.hook("session_entry", entry, "complete", {
      "pi.entry.id": entry.id, "pi.entry.parent_id": entry.parentId ?? undefined,
      "pi.entry.type": entry.type,
    });
    if ((entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") && entry.usage) {
      this.emit("api_request", {
        request_id: this.id("request", entry.id),
        input_tokens: entry.usage.input, output_tokens: entry.usage.output,
        cache_read_tokens: entry.usage.cacheRead, cache_write_tokens: entry.usage.cacheWrite,
        cost_usd: entry.usage.cost.total,
        model: entry.type === "usage" ? entry.model : undefined,
        query_source: entry.type === "usage" ? "sdk" : "away_summary",
        "pi.usage.kind": entry.type === "usage" ? entry.kind : entry.type,
      }, Date.parse(entry.timestamp));
    }
    this.seenEntries.add(entry.id);
  }

  /** A finalized tree scan captures system deltas, context edits and extension-only entries. */
  scan(entries: SessionEntry[]): void {
    for (const entry of entries) {
      if (entry.type === "message") {
        // User/assistant/tool messages arrive through message_end. System and idle custom
        // messages may be persisted without an extension message event.
        if (entry.message.role !== "user" && entry.message.role !== "assistant" && entry.message.role !== "toolResult") {
          this.message(entry.message, true, entry.id, entry.parentId ?? undefined);
        }
      } else this.entry(entry);
    }
  }

  event(event: ExtensionEvent): void {
    switch (event.type) {
      case "turn_start":
        this.request = { id: randomUUID(), started: this.now(), attempt: 0 };
        break;
      case "message_end":
        this.message(event.message);
        return;
      case "message_update": {
        const type = event.assistantMessageEvent.type;
        if (this.request && this.request.firstToken === undefined &&
          ["text_delta", "thinking_delta", "toolcall_delta"].includes(type)) this.request.firstToken = this.now();
        if (!this.config.captureStream) return;
        // Delta only: serializing the growing message on every token is quadratic.
        const update = event.assistantMessageEvent;
        const { partial: _partial, ...delta } = update as unknown as Record<string, unknown>;
        this.hook(event.type, delta);
        return;
      }
      case "provider_stream_event":
      case "tool_execution_update":
        if (!this.config.captureStream) return;
        break;
      case "before_provider_request":
        if (this.request) this.request.attempt++;
        this.hook(event.type, event.payload, "start", { "pi.request.attempt": this.request?.attempt });
        return;
      case "before_provider_headers":
      case "after_provider_response": {
        const sanitized = { ...event, headers: safeHeaders(event.headers) };
        this.hook(event.type, sanitized);
        if (event.type === "after_provider_response" && event.status >= 400) this.emit("api_error", {
          "pi.event.name": event.type, "http.response.status_code": event.status,
        });
        return;
      }
      case "tool_call":
        this.emit("tool_decision", {
          "pi.event.name": event.type, tool_name: event.toolName, tool_call_id: event.toolCallId,
          "pi.tool.parent_call_id": event.parentToolCallId,
          "pi.tool.input": this.config.captureContent ? json(event.input) : undefined,
        });
        return;
      case "tool_execution_start":
        this.tools.set(event.toolCallId, {
          started: this.now(), promptId: this.promptId, requestId: this.request?.id,
        });
        break;
      case "tool_result": {
        if (event.toolName === "read" && !event.isError) {
          const path = event.input.path;
          if (typeof path === "string" && /(?:^|[/\\])SKILL\.md$/i.test(path)) this.emit("skill_activated", {
            skill_name: path.replace(/[/\\]SKILL\.md$/i, "").split(/[/\\]/).at(-1),
            "pi.skill.path": this.config.captureContent ? path : undefined,
            "pi.skill.detection": "successful_read",
          });
        }
        const tool = this.tools.get(event.toolCallId);
        // Transcript calls get their authoritative result at message_end. Preserve
        // this pre-final hook as raw data without doubling Adoption's tool count.
        if (!event.parentToolCallId) {
          this.hook(event.type, event);
          return;
        }
        this.emit("tool_result", {
          "pi.event.name": event.type,
          "prompt.id": tool?.promptId ?? this.promptId,
          request_id: tool?.requestId ?? this.request?.id,
          tool_name: event.toolName, tool_call_id: event.toolCallId,
          "pi.tool.parent_call_id": event.parentToolCallId,
          "pi.tool.phase": "result_hook", success: !event.isError,
          duration_ms: tool ? this.now() - tool.started : undefined,
          "pi.tool.input": this.config.captureContent ? json(event.input) : undefined,
          "pi.tool.result": this.config.captureContent ? json(event) : undefined,
        });
        return;
      }
      case "tool_execution_end": {
        const tool = this.tools.get(event.toolCallId);
        if (tool) tool.ended = this.now();
        if (event.parentToolCallId) this.tools.delete(event.toolCallId);
        break;
      }
    }
    const starts = ["before_agent_start", "agent_start", "turn_start", "context", "context_with_system",
      "session_before_compact", "session_before_tree", "tool_execution_start", "ui_prompt_start"];
    this.hook(event.type, event, starts.includes(event.type) ? "start" : "complete");
  }
}

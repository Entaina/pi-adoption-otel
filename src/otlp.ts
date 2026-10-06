export const EXTENSION_VERSION = "0.1.0";

export type EventName =
  | "user_prompt" | "assistant_response" | "api_request" | "api_error"
  | "tool_decision" | "tool_result" | "plugin_loaded" | "mcp_server_connection"
  | "hook_registered" | "hook_execution_start" | "hook_execution_complete" | "skill_activated";

export type AttributeValue = string | number | boolean | undefined;
export type Attributes = Record<string, AttributeValue>;
export type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
export interface KeyValue { key: string; value: AnyValue }
export interface LogRecord {
  timeUnixNano: string;
  body: { stringValue: EventName };
  attributes: KeyValue[];
}
export interface ExportLogsRequest {
  resourceLogs: {
    resource: { attributes: KeyValue[] };
    scopeLogs: { scope: { name: string; version: string }; logRecords: LogRecord[] }[];
  }[];
}

export function attributes(values: Attributes): KeyValue[] {
  return Object.entries(values).flatMap(([key, value]): KeyValue[] => {
    if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) return [];
    const encoded: AnyValue = typeof value === "string" ? { stringValue: value }
      : typeof value === "boolean" ? { boolValue: value }
      : Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
    return [{ key, value: encoded }];
  });
}

export function logRecord(name: EventName, values: Attributes, timestampMs = Date.now()): LogRecord {
  return {
    timeUnixNano: (BigInt(Math.trunc(timestampMs)) * 1_000_000n).toString(),
    body: { stringValue: name },
    attributes: attributes(values),
  };
}

export function exportRequest(records: LogRecord[], resource: Attributes): ExportLogsRequest {
  return {
    resourceLogs: [{
      resource: { attributes: attributes(resource) },
      scopeLogs: [{ scope: { name: "pi-otel", version: EXTENSION_VERSION }, logRecords: records }],
    }],
  };
}

/** Preserve complete structured content as a scalar: Adoption does not read kvlistValue. */
export function json(value: unknown): string {
  const ancestors: object[] = [];
  return JSON.stringify(value, function (_key, current: unknown) {
    if (typeof current === "bigint") return current.toString();
    if (current instanceof Error) return { name: current.name, message: current.message, stack: current.stack };
    if (current instanceof Map) return Object.fromEntries(current);
    if (current instanceof Set) return [...current];
    if (typeof current !== "object" || current === null) return current;
    while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
    if (ancestors.includes(current)) return "[Circular]";
    ancestors.push(current);
    return current;
  }) ?? "null";
}

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("\n");
}

import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Recorder } from "../src/recorder.js";
import type { LogRecord } from "../src/otlp.js";
import { temporaryConfig, values } from "./helpers.js";

const usage = { input: 1200, output: 310, cacheRead: 200, cacheWrite: 50, totalTokens: 1760,
  cost: { input: 0.003, output: 0.0012, cacheRead: 0, cacheWrite: 0, total: 0.0042 } };
function assistant(content: AssistantMessage["content"] = [{ type: "text", text: "The response" }]): AssistantMessage {
  return { role: "assistant", content, provider: "openai", api: "openai-responses", model: "gpt-4o",
    responseId: "response-1", usage, stopReason: "stop", timestamp: 1000 };
}

function setup(overrides = {}) {
  const { config, cleanup } = temporaryConfig(overrides);
  const records: LogRecord[] = [];
  let time = 2000;
  const recorder = new Recorder(config, "session-1", (record) => records.push(record), {}, [], () => time);
  return { config, cleanup, records, recorder, setTime: (value: number) => { time = value; } };
}

test("captures complete user/assistant messages and correlates tokens, duration and TTFT", () => {
  const { recorder, records, cleanup, setTime } = setup();
  try {
    recorder.event({ type: "message_end", message: { role: "user", content: [
      { type: "text", text: "A prompt" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ], timestamp: 1000 } });
    recorder.event({ type: "turn_start", turnIndex: 0, timestamp: 2000 });
    setTime(2050);
    const partial = assistant();
    recorder.event({ type: "message_update", message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "The", partial } });
    setTime(2500);
    recorder.event({ type: "message_end", message: assistant([
      { type: "thinking", thinking: "Reasoning exposed by provider" }, { type: "text", text: "The response" },
    ]) });
    const user = values(records.find((r) => r.body.stringValue === "user_prompt")!);
    const response = values(records.find((r) => r.body.stringValue === "assistant_response")!);
    const api = values(records.find((r) => r.body.stringValue === "api_request")!);
    assert.equal(user.prompt, "A prompt");
    assert.ok(String(user["pi.message.json"]).includes("aGVsbG8="));
    assert.ok(String(response["pi.message.json"]).includes("Reasoning exposed by provider"));
    assert.equal(response.response, "The response");
    assert.equal(user["prompt.id"], response["prompt.id"]);
    assert.equal(api["prompt.id"], user["prompt.id"]);
    assert.equal(api.request_id, response.request_id);
    assert.equal(api.input_tokens, 1200);
    assert.equal(api.output_tokens, 310);
    assert.equal(api.cache_read_tokens, 200);
    assert.equal(api.cost_usd, 0.0042);
    assert.equal(api.duration_ms, 500);
    assert.equal(api.ttft_ms, 50);
    assert.deepEqual(records.map((r) => values(r)["event.sequence"]), [1, 2, 3, 4, 5]);
    assert.ok(!String(values(records[2])["pi.event.json"]).includes('"partial"'));
  } finally { cleanup(); }
});

test("each consumed steering/follow-up user message gets a separate prompt ID", () => {
  const { recorder, records, cleanup } = setup();
  try {
    for (let i = 0; i < 2; i++) {
      recorder.event({ type: "message_end", message: { role: "user", content: `prompt-${i}`, timestamp: 1000 + i } });
      recorder.event({ type: "turn_start", turnIndex: i, timestamp: 2000 + i });
      recorder.event({ type: "message_end", message: { ...assistant(), timestamp: 3000 + i } });
    }
    const users = records.filter((r) => r.body.stringValue === "user_prompt").map(values);
    const responses = records.filter((r) => r.body.stringValue === "assistant_response").map(values);
    assert.notEqual(users[0]["prompt.id"], users[1]["prompt.id"]);
    assert.equal(users[0]["prompt.id"], responses[0]["prompt.id"]);
    assert.equal(users[1]["prompt.id"], responses[1]["prompt.id"]);
  } finally { cleanup(); }
});

test("known contract vocabulary wraps system prompts, provider payloads and raw events", () => {
  const { recorder, records, cleanup } = setup();
  try {
    recorder.event({ type: "before_provider_request", payload: { instructions: "Complete system prompt", input: ["Full conversation"] } });
    recorder.event({ type: "provider_stream_event", provider: "openai", api: "openai-responses", model: "gpt-4o", data: { delta: "raw" } });
    recorder.event({ type: "before_provider_headers", headers: { Authorization: "Bearer provider-secret", "x-api-key": "key-secret", "x-safe": "ok" } });
    assert.equal(records[0].body.stringValue, "hook_execution_start");
    assert.equal(values(records[0])["pi.event.name"], "before_provider_request");
    assert.ok(String(values(records[0])["pi.event.json"]).includes("Complete system prompt"));
    const headers = String(values(records[2])["pi.event.json"]);
    assert.ok(headers.includes("[REDACTED]"));
    assert.ok(!headers.includes("provider-secret"));
    assert.ok(!headers.includes("key-secret"));
    assert.ok(headers.includes("ok"));
  } finally { cleanup(); }
});

test("tools, nested results, errors and successful skill reads are captured", () => {
  const { recorder, records, cleanup, setTime } = setup();
  try {
    recorder.event({ type: "tool_call", toolCallId: "parent/1", parentToolCallId: "parent", toolName: "read", input: { path: "/skills/foo/SKILL.md" } });
    recorder.event({ type: "tool_execution_start", toolCallId: "parent/1", parentToolCallId: "parent", toolName: "read", args: {} });
    setTime(2100);
    recorder.event({ type: "tool_result", toolCallId: "parent/1", parentToolCallId: "parent", toolName: "read",
      input: { path: "/skills/foo/SKILL.md" }, content: [{ type: "text", text: "skill instructions" }], isError: false, details: undefined });
    const result = values(records.find((r) => r.body.stringValue === "tool_result")!);
    assert.equal(result.duration_ms, 100);
    assert.equal(result["pi.tool.parent_call_id"], "parent");
    assert.ok(String(result["pi.tool.result"]).includes("skill instructions"));
    assert.equal(values(records.find((r) => r.body.stringValue === "skill_activated")!).skill_name, "foo");
    recorder.event({ type: "message_end", message: { ...assistant(), stopReason: "error", errorMessage: "provider failed" } });
    assert.equal(values(records.find((r) => r.body.stringValue === "api_error")!).error, "provider failed");
  } finally { cleanup(); }
});

test("metadata-only mode exports neither prompts nor raw nested content", () => {
  const { recorder, records, cleanup } = setup({ captureContent: false });
  try {
    recorder.event({ type: "message_end", message: { role: "user", content: "private-user", timestamp: 1 } });
    recorder.event({ type: "message_end", message: assistant([{ type: "text", text: "private-response" }]) });
    recorder.event({ type: "before_provider_request", payload: { secret: "private-system" } });
    recorder.event({ type: "tool_call", toolName: "write", toolCallId: "1", input: { content: "private-file" } });
    recorder.event({ type: "input", text: "private-input", source: "interactive" });
    const payload = JSON.stringify(records);
    for (const secret of ["private-user", "private-response", "private-system", "private-file", "private-input"]) {
      assert.ok(!payload.includes(secret), secret);
    }
    assert.equal(values(records.find((r) => r.body.stringValue === "api_request")!).cost_usd, 0.0042);
  } finally { cleanup(); }
});

test("replay, reload and forks use stable prompt identities and a session-wide sequence", () => {
  const { config, recorder, records, cleanup } = setup();
  const branch: SessionEntry[] = [
    { type: "message", id: "user1", parentId: null, timestamp: new Date(1000).toISOString(), message: { role: "user", content: "old prompt", timestamp: 1000 } },
    { type: "message", id: "assistant1", parentId: "user1", timestamp: new Date(1001).toISOString(), message: assistant() },
  ];
  try {
    recorder.history(branch);
    assert.equal(records[0].timeUnixNano, "1000000000");
    const promptId = values(records[0])["prompt.id"];
    const checkpoint = recorder.checkpoint();
    const afterReload: LogRecord[] = [];
    const reloaded = new Recorder(config, "session-1", (record) => afterReload.push(record), {}, [checkpoint]);
    reloaded.history(branch);
    assert.equal(afterReload.length, 0);
    reloaded.event({ type: "turn_start", turnIndex: 0, timestamp: 2000 });
    reloaded.event({ type: "message_end", message: { ...assistant(), timestamp: 2000 } });
    assert.equal(values(afterReload[1])["prompt.id"], promptId);
    assert.equal(values(afterReload[0])["event.sequence"], checkpoint.sequence + 1);
    const forked: LogRecord[] = [];
    const fork = new Recorder(config, "session-2", (record) => forked.push(record), {}, [checkpoint]);
    fork.history(branch);
    assert.ok(forked.length > 0);
    assert.notEqual(values(forked[0])["prompt.id"], promptId);
    assert.equal(values(forked[0])["event.sequence"], 1);
  } finally { cleanup(); }
});

test("summarization and cache warm usage are exported once and marked auxiliary", () => {
  const { recorder, records, cleanup } = setup();
  const entry: SessionEntry = { type: "compaction", id: "summary1", parentId: null, timestamp: new Date(1000).toISOString(),
    summary: "Full summary", firstKeptEntryId: "summary1", tokensBefore: 50000, usage };
  try {
    recorder.entry(entry);
    recorder.entry(entry);
    assert.equal(records.length, 2);
    const api = values(records[1]);
    assert.equal(api.query_source, "away_summary");
    assert.equal(api.cost_usd, 0.0042);
    assert.ok(String(values(records[0])["pi.event.json"]).includes("Full summary"));
  } finally { cleanup(); }
});

test("tool usage includes nested work only once, via the finalized top-level message", () => {
  const { recorder, records, cleanup } = setup();
  try {
    recorder.event({ type: "tool_result", toolCallId: "parent/1", parentToolCallId: "parent", toolName: "nested",
      input: {}, content: [], isError: false, usage, details: undefined });
    assert.equal(records.filter((r) => r.body.stringValue === "api_request").length, 0);
    recorder.event({ type: "message_end", message: { role: "toolResult", toolCallId: "parent", toolName: "outer",
      content: [], isError: false, usage, timestamp: 1000 } });
    const apis = records.filter((r) => r.body.stringValue === "api_request");
    assert.equal(apis.length, 1);
    assert.equal(values(apis[0]).cost_usd, 0.0042);
    assert.equal(values(apis[0])["pi.usage.kind"], "tool");
  } finally { cleanup(); }
});

test("stream capture can be disabled without losing finalized messages", () => {
  const { recorder, records, cleanup } = setup({ captureStream: false });
  try {
    recorder.event({ type: "provider_stream_event", provider: "openai", api: "openai-responses", model: "gpt-4o", data: { private: "stream" } });
    assert.equal(records.length, 0);
    recorder.event({ type: "message_end", message: assistant() });
    assert.equal(records[0].body.stringValue, "assistant_response");
  } finally { cleanup(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { attributes, exportRequest, json, logRecord, textContent } from "../src/otlp.js";

test("OTLP encodes 64-bit integers as strings, and the body as the contract event name", () => {
  const record = logRecord("user_prompt", { "session.id": "session-1", "event.sequence": 1, prompt: "Hola" }, 1760000000000);
  assert.equal(record.timeUnixNano, "1760000000000000000");
  assert.deepEqual(record.body, { stringValue: "user_prompt" });
  assert.deepEqual(record.attributes[1], { key: "event.sequence", value: { intValue: "1" } });
  const payload = exportRequest([record], { "service.name": "pi", "app.version": "1.0.4" });
  assert.equal(payload.resourceLogs[0].scopeLogs[0].scope.name, "pi-otel");
  assert.deepEqual(payload.resourceLogs[0].scopeLogs[0].logRecords, [record]);
  assert.deepEqual(attributes({ money: 0.0042, flag: true, absent: undefined, invalid: NaN }), [
    { key: "money", value: { doubleValue: 0.0042 } }, { key: "flag", value: { boolValue: true } },
  ]);
});

test("structured content is a complete scalar JSON string, without truncation", () => {
  const content = [{ type: "text", text: "x".repeat(100_000) }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
  assert.deepEqual(JSON.parse(json(content)), content);
  assert.equal(textContent(content), "x".repeat(100_000));
  assert.equal(textContent([{ type: "thinking", thinking: "internal" }, { type: "text", text: "Hola" }]), "Hola");
});

test("safe serializer preserves repeated references and handles cycles", () => {
  const shared = { text: "hello" };
  const value: { a: object; b: object; self?: unknown } = { a: shared, b: shared };
  value.self = value;
  assert.deepEqual(JSON.parse(json(value)), { a: shared, b: shared, self: "[Circular]" });
  assert.equal(json(123n), '"123"');
});

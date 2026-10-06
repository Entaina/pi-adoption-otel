import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { overriddenBy, readSettings, settingsPath, withSettings, writeSettings } from "../src/settings.js";

const saved = { endpoint: "http://localhost:3986/api", token: "secret", userEmail: "ana@example.com" };

test("saved settings configure the extension without environment variables", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-otel-settings-"));
  const path = settingsPath(dir);
  assert.deepEqual(readSettings(path), {});
  writeSettings(path, { ...saved, captureStream: false, batchSize: 10, serviceName: "" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const settings = readSettings(path);
  assert.equal(settings.serviceName, undefined);
  const config = loadConfig(withSettings({}, settings), dir)!;
  assert.equal(config.endpoint, "http://localhost:3986/api/v1/logs");
  assert.equal(config.headers.authorization, "Bearer secret");
  assert.equal(config.userEmail, "ana@example.com");
  assert.equal(config.captureStream, false);
  assert.equal(config.batchSize, 10);
});

test("environment variables override saved settings, including standard OTEL equivalents", () => {
  const env = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.com/api",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20fromenv",
    OTEL_RESOURCE_ATTRIBUTES: "user.email=env%40example.com",
  };
  assert.equal(overriddenBy(env, "endpoint"), "OTEL_EXPORTER_OTLP_ENDPOINT");
  assert.equal(overriddenBy(env, "token"), "OTEL_EXPORTER_OTLP_HEADERS");
  assert.equal(overriddenBy(env, "userEmail"), "OTEL_RESOURCE_ATTRIBUTES");
  assert.equal(overriddenBy(env, "serviceName"), undefined);
  const config = loadConfig(withSettings(env, { ...saved, serviceName: "my-pi" }), "/tmp/agent")!;
  assert.equal(config.endpoint, "https://example.com/api/v1/logs");
  assert.equal(config.headers.authorization, "Bearer fromenv");
  assert.equal(config.userEmail, "env@example.com");
  assert.equal(config.serviceName, "my-pi");
});

test("malformed settings files are rejected without leaking their contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-otel-settings-"));
  const path = join(dir, "config.json");
  for (const text of ["{", "[]", '{"token": 1}', '{"unknown": "secret"}']) {
    writeFileSync(path, text);
    assert.throws(() => readSettings(path), (error: Error) => !error.message.includes("secret"));
  }
});

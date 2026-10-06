import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, logsEndpoint, parseHeaders } from "../src/config.js";

const base = { PI_OTEL_ENDPOINT: "http://localhost:3986/api", PI_OTEL_TOKEN: "secret" };

test("disabled unless an endpoint is explicitly configured", () => {
  assert.equal(loadConfig({}, "/tmp/agent"), undefined);
  assert.equal(loadConfig({ ...base, PI_OTEL_ENABLED: "false" }, "/tmp/agent"), undefined);
  const config = loadConfig(base, "/tmp/agent")!;
  assert.equal(config.endpoint, "http://localhost:3986/api/v1/logs");
  assert.equal(config.serviceName, "pi");
  assert.equal(config.captureContent, true);
  assert.equal(config.captureStream, true);
  assert.equal(config.replayHistory, true);
  assert.equal(config.headers["content-type"], "application/json");
  assert.ok(!config.spoolDir.includes("secret"));
});

test("standard OTEL settings, logs-specific precedence, and percent-encoded bearer", () => {
  const config = loadConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.com/api",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://other.example.com/custom/logs",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20personal,x-org=base",
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-org=signal,Content-Type=application/x-protobuf",
    OTEL_RESOURCE_ATTRIBUTES: "service.name=my-pi,user.email=ana%40example.com",
  }, "/tmp/agent")!;
  assert.equal(config.endpoint, "https://other.example.com/custom/logs");
  assert.equal(config.headers.authorization, "Bearer personal");
  assert.equal(config.headers["x-org"], "signal");
  assert.equal(config.headers["content-type"], "application/json");
  assert.equal(config.userEmail, "ana@example.com");
  assert.equal(config.serviceName, "my-pi");
});

test("base URL joins correctly and complete logs endpoints are not doubled", () => {
  assert.equal(logsEndpoint("http://localhost:3986/api/"), "http://localhost:3986/api/v1/logs");
  assert.equal(logsEndpoint("http://localhost:3986/api/v1/logs"), "http://localhost:3986/api/v1/logs");
  assert.equal(logsEndpoint("http://localhost:3986"), "http://localhost:3986/v1/logs");
  assert.throws(() => logsEndpoint("file:///tmp/secret"));
  assert.throws(() => logsEndpoint("https://user:secret@example.com/api"));
  assert.throws(() => logsEndpoint("https://example.com/api?token=secret"));
});

test("invalid configuration fails without including secret values", () => {
  assert.throws(() => loadConfig({ PI_OTEL_ENDPOINT: base.PI_OTEL_ENDPOINT }, "/tmp/agent"), /PI_OTEL_TOKEN/);
  for (const overrides of [
    { OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" },
    { OTEL_SERVICE_NAME: "Claude Code" }, { OTEL_SERVICE_NAME: "cowork" },
    { OTEL_SERVICE_NAME: "!!!" }, { OTEL_SERVICE_NAME: "x".repeat(65) },
    { PI_OTEL_BATCH_SIZE: "0" }, { PI_OTEL_TIMEOUT_MS: "2147483648" },
    { PI_OTEL_CAPTURE_CONTENT: "maybe" }, { PI_OTEL_USER_EMAIL: "not-an-email" },
  ]) assert.throws(() => loadConfig({ ...base, ...overrides }, "/tmp/agent"));
  assert.throws(() => parseHeaders("Authorization"));
  assert.throws(() => parseHeaders("Authorization=Bearer%zz"));
  assert.equal(parseHeaders("x-token=abc=def")["x-token"], "abc=def");
});

test("outboxes cannot cross accounts or users", () => {
  const first = loadConfig(base, "/tmp/agent")!;
  const second = loadConfig({ ...base, PI_OTEL_TOKEN: "other" }, "/tmp/agent")!;
  const third = loadConfig({ ...base, PI_OTEL_USER_EMAIL: "ana@example.com" }, "/tmp/agent")!;
  assert.notEqual(first.destinationId, second.destinationId);
  assert.notEqual(first.destinationId, third.destinationId);
  const metadata = loadConfig({ ...base, PI_OTEL_CAPTURE_CONTENT: "false" }, "/tmp/agent")!;
  assert.notEqual(first.destinationId, metadata.destinationId);
});

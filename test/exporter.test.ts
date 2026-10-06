import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { OtlpExporter, retryAfterMs } from "../src/exporter.js";
import { logRecord } from "../src/otlp.js";
import { temporaryConfig } from "./helpers.js";

const record = () => logRecord("user_prompt", { "session.id": "session-1", "event.sequence": 1, prompt: "Private prompt" }, 1760000000000);

test("exports to a real HTTP server as JSON with a bearer token and correct resource", async () => {
  const requests: { url: string; authorization?: string; contentType?: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests.push({ url: req.url!, authorization: req.headers.authorization, contentType: req.headers["content-type"], body });
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const { config, cleanup } = temporaryConfig({ endpoint: `http://127.0.0.1:${address.port}/api/v1/logs` });
  const exporter = new OtlpExporter(config, { "service.name": "pi" }, () => {});
  try {
    exporter.enqueue(record());
    assert.equal((await exporter.flush()).queuedRecords, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/v1/logs");
    assert.equal(requests[0].authorization, "Bearer test-token");
    assert.equal(requests[0].contentType, "application/json");
    const payload = JSON.parse(requests[0].body);
    assert.equal(payload.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, "user_prompt");
    assert.ok(!requests[0].body.includes("test-token"));
  } finally {
    await exporter.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    cleanup();
  }
});

test("retry resends identical timestamps/sequences/bytes and never drops a rejected batch", async () => {
  const { config, cleanup } = temporaryConfig();
  const bodies: string[] = [];
  const fakeFetch = (async (_url, init) => {
    bodies.push(init!.body as string);
    return new Response("{}", { status: bodies.length === 1 ? 429 : 200, headers: { "retry-after": "1" } });
  }) as typeof fetch;
  const exporter = new OtlpExporter(config, { "service.name": "pi" }, () => {}, fakeFetch);
  try {
    exporter.enqueue(record());
    assert.equal((await exporter.flush()).queuedRecords, 1);
    assert.equal((await exporter.flush()).queuedRecords, 0);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
  } finally { await exporter.close(); cleanup(); }
});

test("401 persists privately, survives close/reload and recovers without storing credentials", async () => {
  const { config, cleanup } = temporaryConfig();
  const warnings: string[] = [];
  const rejected = new OtlpExporter(config, { "service.name": "pi" }, (warning) => warnings.push(warning),
    (async () => new Response(null, { status: 401 })) as typeof fetch);
  rejected.enqueue(record());
  await rejected.close();
  assert.equal(rejected.status().queuedRecords, 1);
  const directory = join(config.spoolDir, readdirSync(config.spoolDir)[0]);
  const file = join(directory, readdirSync(directory)[0]);
  const body = readFileSync(file, "utf8");
  assert.ok(body.includes("Private prompt"));
  assert.ok(!body.includes("test-token"));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.ok(warnings.every((warning) => !warning.includes("Private prompt") && !warning.includes("test-token")));
  const bodies: string[] = [];
  const recovered = new OtlpExporter(config, { "service.name": "pi" }, () => {}, (async (_url, init) => {
    bodies.push(init!.body as string);
    return new Response("{}", { status: 200 });
  }) as typeof fetch);
  try {
    assert.equal((await recovered.flush()).queuedRecords, 0);
    assert.deepEqual(bodies, [body]);
  } finally { await recovered.close(); cleanup(); }
});

test("active pi processes do not steal each other's pending batches", async () => {
  const { config, cleanup } = temporaryConfig();
  const reject = (async () => new Response(null, { status: 401 })) as typeof fetch;
  const first = new OtlpExporter(config, { "service.name": "pi" }, () => {}, reject);
  first.enqueue(record());
  first.persist();
  const second = new OtlpExporter(config, { "service.name": "pi" }, () => {}, reject);
  try {
    assert.equal(second.status().queuedRecords, 0);
    assert.equal(first.status().queuedRecords, 1);
  } finally { await first.close(); await second.close(); cleanup(); }
});

test("shutdown is bounded even if the HTTP peer never replies", async () => {
  const { config, cleanup } = temporaryConfig({ timeoutMs: 10_000, shutdownTimeoutMs: 20 });
  const fakeFetch = ((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })) as typeof fetch;
  const exporter = new OtlpExporter(config, { "service.name": "pi" }, () => {}, fakeFetch);
  exporter.enqueue(record());
  const started = Date.now();
  try {
    await exporter.close();
    assert.ok(Date.now() - started < 1000);
    assert.equal(exporter.status().queuedRecords, 1);
    await exporter.close(); // Idempotent.
  } finally { cleanup(); }
});

test("Retry-After handles seconds and HTTP dates", () => {
  assert.equal(retryAfterMs("3"), 3000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:00:10 GMT", 8000), 2000);
  assert.equal(retryAfterMs("invalid"), undefined);
});

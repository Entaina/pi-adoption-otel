import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import piOtel from "../src/index.js";
import type { LogRecord } from "../src/otlp.js";
import { values } from "./helpers.js";

// Real pi SDK and tools, simulated model and local ingest; no paid API calls or real telemetry.
test("real pi lifecycle exports prompts, provider payloads, tools and responses without changing them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-otel-integration-"));
  const saved = { ...process.env };
  const batches: { resourceLogs: { scopeLogs: { logRecords: LogRecord[] }[] }[] }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(request.url, "/api/v1/logs");
    assert.equal(request.headers.authorization, "Bearer local-test-token");
    batches.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PI_OTEL_") || key.startsWith("OTEL_")) delete process.env[key];
  }
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: directory,
    PI_OTEL_ENDPOINT: `http://127.0.0.1:${address.port}/api`,
    PI_OTEL_TOKEN: "local-test-token",
    PI_OTEL_USER_EMAIL: "ana@example.com",
    PI_OTEL_FLUSH_INTERVAL_MS: "60000",
    PI_OFFLINE: "1",
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const fixture = join(directory, "fixture.txt");
    writeFileSync(fixture, "Tool output visible to pi");
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
    });
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [piOtel], systemPrompt: "Private system instructions for this test",
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null,
      modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    await modelRuntime.setRuntimeApiKey("openai", "fake-model-key");
    const model = getModel("openai", "gpt-4o");
    assert.ok(model);
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory,
      model, modelRuntime, resourceLoader: loader, settingsManager,
      sessionManager: SessionManager.inMemory(directory), tools: ["read"], thinkingLevel: "off" }));
    const extensionErrors: string[] = [];
    await session.bindExtensions({ mode: "print", onError: (error) => extensionErrors.push(error.error) });
    assert.equal(session.extensionRunner.hasHandlers("mcp_servers_change"), false);
    let calls = 0;
    session.agent.streamFunction = async (requestedModel, context, options) => {
      calls++;
      const payload = { instructions: "Complete provider system prompt", messages: context.messages };
      assert.deepEqual(await options?.onPayload?.(payload, requestedModel), payload);
      await options?.onResponse?.({ status: 200, headers: { "x-request-id": `req-${calls}` } }, requestedModel);
      await options?.onProviderStreamEvent?.({ type: "test.raw", value: "Provider event" }, requestedModel);
      const message: AssistantMessage = {
        role: "assistant", provider: "openai", api: "openai-responses", model: "gpt-4o", timestamp: Date.now(),
        content: calls === 1
          ? [{ type: "toolCall", id: "read-fixture", name: "read", arguments: { path: fixture } }]
          : [{ type: "text", text: "Complete final response" }],
        stopReason: calls === 1 ? "toolUse" : "stop",
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      stream.end(message);
      return stream;
    };
    await session.prompt("Private integration prompt", { source: "rpc" });
    assert.equal(session.getLastAssistantText(), "Complete final response");
    assert.equal(calls, 2);
    await session.prompt("/otel flush");
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.deepEqual(extensionErrors, []);
    const records = batches.flatMap((batch) => batch.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords)));
    const users = records.filter((r) => r.body.stringValue === "user_prompt");
    assert.equal(users.length, 1);
    assert.equal(values(users[0]).prompt, "Private integration prompt");
    assert.equal(values(users[0])["user.email"], "ana@example.com");
    assert.equal(records.filter((r) => r.body.stringValue === "api_request").length, 2);
    const assistant = records.find((r) => r.body.stringValue === "assistant_response")!;
    assert.equal(values(assistant).response, "Complete final response");
    assert.equal(values(assistant)["prompt.id"], values(users[0])["prompt.id"]);
    assert.ok(records.some((r) => r.body.stringValue === "tool_decision"));
    assert.equal(records.filter((r) => r.body.stringValue === "tool_result").length, 1);
    assert.ok(records.some((r) => r.body.stringValue === "tool_result" && JSON.stringify(r).includes("Tool output visible to pi")));
    assert.equal(typeof values(records.find((r) => r.body.stringValue === "tool_result")!).duration_ms, "number");
    assert.ok(records.some((r) => values(r)["pi.event.name"] === "context_with_system" &&
      String(values(r)["pi.event.json"]).includes("Private system instructions for this test")));
    assert.ok(records.some((r) => values(r)["pi.event.name"] === "before_provider_request" &&
      String(values(r)["pi.event.json"]).includes("Complete provider system prompt")));
    assert.ok(records.some((r) => values(r)["pi.event.name"] === "provider_stream_event"));
    assert.ok(!JSON.stringify(batches).includes("local-test-token"));
    assert.ok(!JSON.stringify(batches).includes("fake-model-key"));
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import type { LogRecord } from "../src/otlp.js";

export function temporaryConfig(overrides: Partial<Config> = {}): { config: Config; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "pi-otel-test-"));
  const config = loadConfig({ PI_OTEL_ENDPOINT: "http://127.0.0.1:3986/api", PI_OTEL_TOKEN: "test-token" }, directory)!;
  return {
    config: { ...config, flushIntervalMs: 60_000, timeoutMs: 100, shutdownTimeoutMs: 200, ...overrides },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export function values(record: LogRecord): Record<string, string | number | boolean> {
  return Object.fromEntries(record.attributes.map(({ key, value }) => {
    if ("stringValue" in value) return [key, value.stringValue];
    if ("intValue" in value) return [key, Number(value.intValue)];
    if ("doubleValue" in value) return [key, value.doubleValue];
    return [key, value.boolValue];
  }));
}

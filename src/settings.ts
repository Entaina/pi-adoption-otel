import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { parseHeaders } from "./config.js";

/** Settings saved by `/otel setup`. Each one mirrors an environment variable. */
export interface Settings {
  enabled?: boolean;
  endpoint?: string;
  token?: string;
  userEmail?: string;
  serviceName?: string;
  captureContent?: boolean;
  captureStream?: boolean;
  replayHistory?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
  timeoutMs?: number;
  shutdownTimeoutMs?: number;
  spoolDir?: string;
}

export type SettingKey = keyof Settings;

export const SETTING_ENV: Record<SettingKey, string> = {
  enabled: "PI_OTEL_ENABLED",
  endpoint: "PI_OTEL_ENDPOINT",
  token: "PI_OTEL_TOKEN",
  userEmail: "PI_OTEL_USER_EMAIL",
  serviceName: "OTEL_SERVICE_NAME",
  captureContent: "PI_OTEL_CAPTURE_CONTENT",
  captureStream: "PI_OTEL_CAPTURE_STREAM",
  replayHistory: "PI_OTEL_REPLAY_HISTORY",
  batchSize: "PI_OTEL_BATCH_SIZE",
  flushIntervalMs: "PI_OTEL_FLUSH_INTERVAL_MS",
  timeoutMs: "PI_OTEL_TIMEOUT_MS",
  shutdownTimeoutMs: "PI_OTEL_SHUTDOWN_TIMEOUT_MS",
  spoolDir: "PI_OTEL_SPOOL_DIR",
};

const KIND: Record<SettingKey, "string" | "boolean" | "number"> = {
  enabled: "boolean", endpoint: "string", token: "string", userEmail: "string", serviceName: "string",
  captureContent: "boolean", captureStream: "boolean", replayHistory: "boolean",
  batchSize: "number", flushIntervalMs: "number", timeoutMs: "number", shutdownTimeoutMs: "number",
  spoolDir: "string",
};

export function settingsPath(agentDir: string): string {
  return join(agentDir, "pi-otel", "config.json");
}

export function readSettings(path: string): Settings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read ${path}`);
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error(`${path} is not valid JSON`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${path} must contain a JSON object`);
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const kind = KIND[key as SettingKey];
    if (!kind) throw new Error(`${path}: unknown setting "${key}"`);
    if (value === null || value === undefined) continue;
    if (typeof value !== kind) throw new Error(`${path}: "${key}" must be a ${kind}`);
    settings[key] = value;
  }
  return settings as Settings;
}

/** Atomically writes the settings readable only by the owner: the file may contain a token. */
export function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const clean = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined && value !== ""));
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function headerHas(env: NodeJS.ProcessEnv, variable: string, header: string): boolean {
  try { return Boolean(parseHeaders(env[variable])[header]); } catch { return Boolean(env[variable]?.trim()); }
}

/**
 * Returns the environment variable that overrides a saved setting, if any. The environment
 * always wins so that a single process can be redirected without editing the saved file.
 */
export function overriddenBy(env: NodeJS.ProcessEnv, key: SettingKey): string | undefined {
  const set = (name: string) => Boolean(env[name]?.trim());
  switch (key) {
    case "endpoint":
      return ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "PI_OTEL_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"].find(set);
    case "token":
      if (set("PI_OTEL_TOKEN")) return "PI_OTEL_TOKEN";
      return ["OTEL_EXPORTER_OTLP_LOGS_HEADERS", "OTEL_EXPORTER_OTLP_HEADERS"]
        .find((name) => headerHas(env, name, "authorization"));
    case "serviceName":
      if (set("OTEL_SERVICE_NAME")) return "OTEL_SERVICE_NAME";
      return headerHas(env, "OTEL_RESOURCE_ATTRIBUTES", "service.name") ? "OTEL_RESOURCE_ATTRIBUTES" : undefined;
    case "userEmail":
      if (set("PI_OTEL_USER_EMAIL")) return "PI_OTEL_USER_EMAIL";
      return headerHas(env, "OTEL_RESOURCE_ATTRIBUTES", "user.email") ? "OTEL_RESOURCE_ATTRIBUTES" : undefined;
    default:
      return set(SETTING_ENV[key]) ? SETTING_ENV[key] : undefined;
  }
}

/** Merges saved settings into the environment so that `loadConfig` validates both sources the same way. */
export function withSettings(env: NodeJS.ProcessEnv, settings: Settings): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(settings) as [SettingKey, Settings[SettingKey]][]) {
    if (value === undefined || value === "" || overriddenBy(env, key)) continue;
    merged[SETTING_ENV[key]] = String(value);
  }
  return merged;
}

import { createHash } from "node:crypto";
import { join } from "node:path";

export interface Config {
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
  userEmail?: string;
  captureContent: boolean;
  captureStream: boolean;
  replayHistory: boolean;
  batchSize: number;
  flushIntervalMs: number;
  timeoutMs: number;
  shutdownTimeoutMs: number;
  spoolDir: string;
  destinationId: string;
}

function boolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const value = env[key]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes"].includes(value)) return true;
  if (["0", "false", "no"].includes(value)) return false;
  throw new Error(`${key}: use true or false`);
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new Error(`${key}: expected a positive integer <= 2147483647`);
  }
  return parsed;
}

export function parseHeaders(value = ""): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const part of value.split(",")) {
    if (!part.trim()) continue;
    const index = part.indexOf("=");
    if (index < 1) throw new Error("OTLP headers must be key=value pairs");
    const key = part.slice(0, index).trim().toLowerCase();
    const text = part.slice(index + 1).trim();
    try {
      headers[key] = decodeURIComponent(text);
    } catch {
      throw new Error("OTLP header value has invalid percent encoding");
    }
  }
  // Fail early for invalid names, newlines and other invalid HTTP values.
  new Headers(headers);
  return headers;
}

export function logsEndpoint(base: string, signalSpecific = false): string {
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("OTLP endpoint must be HTTP(S), without credentials in the URL");
  }
  if (url.search || url.hash) throw new Error("OTLP endpoint must not have a query or fragment");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = !signalSpecific && !path.endsWith("/v1/logs") ? `${path}/v1/logs` : path || "/";
  return url.toString();
}

export function loadConfig(env: NodeJS.ProcessEnv, agentDir: string): Config | undefined {
  if (!boolean(env, "PI_OTEL_ENABLED", true)) return undefined;
  const signalEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  const base = signalEndpoint || env.PI_OTEL_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!base) return undefined;
  const protocol = env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL || env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol && protocol !== "http/json") throw new Error("Adoption only supports OTLP http/json");
  const headers = {
    ...parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseHeaders(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS),
  };
  const token = env.PI_OTEL_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  if (!/^Bearer\s+\S+$/i.test(headers.authorization || "")) {
    throw new Error("Set PI_OTEL_TOKEN or an OTLP Authorization=Bearer <token> header");
  }
  // Never allow headers to select protobuf, compression or an incorrect body length.
  delete headers["content-encoding"];
  delete headers["content-length"];
  headers["content-type"] = "application/json";
  new Headers(headers);
  const resourceAttributes = parseHeaders(env.OTEL_RESOURCE_ATTRIBUTES);
  const serviceName = env.OTEL_SERVICE_NAME?.trim() || resourceAttributes["service.name"] || "pi";
  const slug = serviceName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!slug || slug.length > 64 || ["cowork", "claude_code"].includes(slug)) {
    throw new Error("service.name must be a non-reserved product slug of 1–64 characters");
  }
  const userEmail = env.PI_OTEL_USER_EMAIL?.trim() || resourceAttributes["user.email"];
  if (userEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) {
    throw new Error("PI_OTEL_USER_EMAIL must be a valid email address");
  }
  const endpoint = logsEndpoint(base, Boolean(signalEndpoint));
  const captureContent = boolean(env, "PI_OTEL_CAPTURE_CONTENT", true);
  // Isolate metadata-only queues so that disabling content cannot drain older full-content batches.
  // Separate accounts/tokens and endpoints, without saving credentials to disk.
  const destinationId = createHash("sha256")
    .update(JSON.stringify([endpoint, serviceName, userEmail, headers.authorization, captureContent]))
    .digest("hex").slice(0, 24);
  return {
    endpoint, headers, serviceName, userEmail, destinationId,
    captureContent,
    captureStream: boolean(env, "PI_OTEL_CAPTURE_STREAM", true),
    replayHistory: boolean(env, "PI_OTEL_REPLAY_HISTORY", true),
    batchSize: positiveInt(env, "PI_OTEL_BATCH_SIZE", 100),
    flushIntervalMs: positiveInt(env, "PI_OTEL_FLUSH_INTERVAL_MS", 1000),
    timeoutMs: positiveInt(env, "PI_OTEL_TIMEOUT_MS", 10000),
    shutdownTimeoutMs: positiveInt(env, "PI_OTEL_SHUTDOWN_TIMEOUT_MS", 5000),
    spoolDir: join(env.PI_OTEL_SPOOL_DIR || join(agentDir, "pi-otel", "outbox"), destinationId),
  };
}

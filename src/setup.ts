import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { overriddenBy, withSettings, writeSettings, type SettingKey, type Settings } from "./settings.js";

interface Field {
  key: SettingKey;
  label: string;
  hint?: string;
}

const MAIN: Field[] = [
  { key: "endpoint", label: "Endpoint", hint: "OTLP base URL, e.g. https://adoption.entaina.ai/api" },
  { key: "token", label: "Token", hint: "Adoption bearer token" },
  { key: "userEmail", label: "User email", hint: "Required for account tokens" },
  { key: "serviceName", label: "Service name", hint: "Product slug in Adoption (default: pi)" },
  { key: "captureContent", label: "Capture content" },
  { key: "captureStream", label: "Capture stream" },
  { key: "replayHistory", label: "Replay history" },
  { key: "enabled", label: "Enabled" },
];

const ADVANCED: Field[] = [
  { key: "batchSize", label: "Batch size", hint: "Records per request (default: 100)" },
  { key: "flushIntervalMs", label: "Flush interval (ms)", hint: "Default: 1000" },
  { key: "timeoutMs", label: "Request timeout (ms)", hint: "Default: 10000" },
  { key: "shutdownTimeoutMs", label: "Shutdown timeout (ms)", hint: "Default: 5000" },
  { key: "spoolDir", label: "Outbox directory", hint: "Default: <agent-dir>/pi-otel/outbox" },
];

const BOOLEAN_DEFAULTS: Partial<Record<SettingKey, boolean>> = {
  enabled: true, captureContent: true, captureStream: true, replayHistory: true,
};

function mask(token: string): string {
  return token.length <= 8 ? "••••" : `••••${token.slice(-4)}`;
}

function display(settings: Settings, env: NodeJS.ProcessEnv, field: Field): string {
  const value = settings[field.key];
  let text: string;
  if (field.key in BOOLEAN_DEFAULTS) text = (value ?? BOOLEAN_DEFAULTS[field.key]) ? "on" : "off";
  else if (value === undefined || value === "") text = "—";
  else text = field.key === "token" ? mask(String(value)) : String(value);
  const variable = overriddenBy(env, field.key);
  return `${field.label}: ${text}${variable ? `  (overridden by $${variable})` : ""}`;
}

async function edit(ctx: ExtensionContext, settings: Settings, field: Field): Promise<void> {
  if (field.key in BOOLEAN_DEFAULTS) {
    const current = (settings[field.key] as boolean | undefined) ?? BOOLEAN_DEFAULTS[field.key]!;
    (settings as Record<string, unknown>)[field.key] = !current;
    return;
  }
  const current = settings[field.key];
  const placeholder = current === undefined ? field.hint : field.key === "token" ? mask(String(current)) : String(current);
  // pi's input dialog has no prefill: an empty answer keeps the value, "-" removes it.
  const answer = await ctx.ui.input(`${field.label} — Enter keeps the current value, "-" clears it`, placeholder);
  const text = answer?.trim();
  if (!text) return;
  if (text === "-") {
    delete settings[field.key];
    return;
  }
  if (["batchSize", "flushIntervalMs", "timeoutMs", "shutdownTimeoutMs"].includes(field.key)) {
    const number = Number(text);
    if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
      ctx.ui.notify(`[pi-otel] ${field.label}: expected a positive integer`, "error");
      return;
    }
    (settings as Record<string, unknown>)[field.key] = number;
    return;
  }
  (settings as Record<string, unknown>)[field.key] = text;
}

/** Validates through the same `loadConfig` path used at startup, with the environment applied on top. */
function validate(settings: Settings, env: NodeJS.ProcessEnv, agentDir: string): string | undefined {
  try {
    loadConfig(withSettings(env, settings), agentDir);
    return undefined;
  } catch (error) {
    return error instanceof Error && !(error instanceof TypeError) ? error.message : "Invalid endpoint or header value";
  }
}

async function menu(ctx: ExtensionContext, title: string, fields: Field[], settings: Settings,
  env: NodeJS.ProcessEnv, actions: string[]): Promise<string | undefined> {
  while (true) {
    const labels = fields.map((field) => display(settings, env, field));
    const choice = await ctx.ui.select(title, [...labels, ...actions]);
    if (choice === undefined) return undefined;
    const index = labels.indexOf(choice);
    if (index < 0) return choice;
    await edit(ctx, settings, fields[index]!);
  }
}

const ADVANCED_ACTION = "Advanced…";
const BACK_ACTION = "← Back";
const SAVE_ACTION = "Save and reload";
const CANCEL_ACTION = "Cancel";

/** Interactive editor for the saved settings. Returns true when the file was written. */
export async function runSetup(ctx: ExtensionContext, initial: Settings, path: string,
  env: NodeJS.ProcessEnv, agentDir: string): Promise<boolean> {
  const settings: Settings = { ...initial };
  while (true) {
    const action = await menu(ctx, "pi-otel settings", MAIN, settings, env, [ADVANCED_ACTION, SAVE_ACTION, CANCEL_ACTION]);
    if (action === ADVANCED_ACTION) {
      await menu(ctx, "pi-otel · advanced", ADVANCED, settings, env, [BACK_ACTION]);
      continue;
    }
    if (action !== SAVE_ACTION) return false;
    const error = validate(settings, env, agentDir);
    if (error) {
      ctx.ui.notify(`[pi-otel] ${error}`, "error");
      continue;
    }
    if (settings.token && !(await ctx.ui.confirm("Save token?",
      `The token will be stored in plain text, readable only by your user:\n${path}`))) continue;
    writeSettings(path, settings);
    return true;
  }
}

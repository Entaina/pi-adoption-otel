import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "./config.js";
import { exportRequest, type Attributes, type LogRecord } from "./otlp.js";

export interface ExporterStatus {
  queuedRecords: number;
  queuedBatches: number;
  acceptedRecords: number;
  lastError?: string;
  blocked: boolean;
}
interface Batch { path: string; count: number }

function processAlive(pid: number): boolean {
  if (pid === 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Native OTLP/HTTP JSON exporter; no provider credentials or content in diagnostics. */
export class OtlpExporter {
  private buffer: LogRecord[] = [];
  private batches: Batch[] = [];
  private directories: string[] = [];
  private directory: string;
  private timer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private worker?: Promise<void>;
  private controller?: AbortController;
  private stopped = false;
  private closing = false;
  private failures = 0;
  private acceptedRecords = 0;
  private lastError?: string;
  private blocked = false;
  private fileSequence = 0;

  constructor(
    private config: Config,
    private resource: Attributes,
    private warn: (message: string) => void,
    private fetchImpl: typeof fetch = fetch,
  ) {
    // Construct only from session_start, never from the extension factory.
    mkdirSync(config.spoolDir, { recursive: true, mode: 0o700 });
    this.directory = join(config.spoolDir, `${process.pid}-${randomUUID()}`);
    mkdirSync(this.directory, { mode: 0o700 });
    this.directories.push(this.directory);
    this.recover();
    this.timer = setInterval(() => {
      try { this.persist(); this.kick(); }
      catch { this.report("Could not persist OTLP records; check outbox permissions and free space"); }
    }, config.flushIntervalMs);
    this.timer.unref();
    this.kick();
  }

  private recover(): void {
    for (const name of readdirSync(this.config.spoolDir)) {
      if (!/^\d+-[0-9a-f-]+$/.test(name) || processAlive(Number(name.split("-")[0]))) continue;
      const source = join(this.config.spoolDir, name);
      const claimed = join(this.config.spoolDir, `${process.pid}-${randomUUID()}`);
      try { renameSync(source, claimed); }
      catch { continue; } // Another pi process may have claimed this outbox.
      this.directories.push(claimed);
      for (const file of readdirSync(claimed).filter((item) => item.endsWith(".json"))) {
        const path = join(claimed, file);
        try {
          const request = JSON.parse(readFileSync(path, "utf8"));
          const records = request.resourceLogs?.flatMap((r: { scopeLogs?: { logRecords?: unknown[] }[] }) =>
            r.scopeLogs?.flatMap((s) => s.logRecords ?? []) ?? []);
          if (!Array.isArray(records) || !records.length) throw new Error("Invalid outbox");
          this.batches.push({ path, count: records.length });
        } catch {
          // Keep corrupt files for inspection, not for endless blocking retries.
          this.report("An invalid OTLP outbox file was retained but will not be sent");
        }
      }
    }
    this.batches.sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
  }

  enqueue(record: LogRecord): void {
    if (this.stopped || this.closing) return;
    this.buffer.push(record);
    if (this.buffer.length >= this.config.batchSize) {
      this.persist();
      this.kick();
    }
  }

  /** Persist before committing replay checkpoints. Failed writes leave the buffer intact. */
  persist(): void {
    while (this.buffer.length) {
      const records = this.buffer.slice(0, this.config.batchSize);
      const path = join(this.directory,
        `${Date.now()}-${String(this.fileSequence++).padStart(8, "0")}-${randomUUID()}.json`);
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, JSON.stringify(exportRequest(records, this.resource)), { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
      this.batches.push({ path, count: records.length });
      this.buffer.splice(0, records.length);
    }
  }

  status(): ExporterStatus {
    return {
      queuedRecords: this.buffer.length + this.batches.reduce((total, batch) => total + batch.count, 0),
      queuedBatches: this.batches.length,
      acceptedRecords: this.acceptedRecords,
      lastError: this.lastError,
      blocked: this.blocked,
    };
  }

  private report(message: string): void {
    if (this.lastError !== message) {
      try { this.warn(message); } catch { /* Diagnostics must never reject a background worker. */ }
    }
    this.lastError = message;
  }

  private kick(): void {
    if (this.worker || this.retryTimer || this.stopped || this.blocked || !this.batches.length) return;
    this.worker = this.send().finally(() => { this.worker = undefined; });
  }

  private retry(delay?: number): void {
    if (this.closing || this.stopped) return;
    const backoff = Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5));
    // Node timers cannot represent delays beyond a signed 32-bit integer.
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.kick();
    }, Math.min(2_147_483_647, Math.max(backoff, delay ?? 0)));
    this.retryTimer.unref();
  }

  private async send(): Promise<void> {
    while (this.batches.length && !this.stopped) {
      const batch = this.batches[0];
      this.controller = new AbortController();
      try {
        const body = readFileSync(batch.path, "utf8");
        const response = await this.fetchImpl(this.config.endpoint, {
          method: "POST", headers: this.config.headers, body,
          redirect: "error", // Do not forward the bearer token to redirects.
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.config.timeoutMs)]),
        });
        await response.body?.cancel();
        if (response.status !== 200) {
          this.report(`OTLP HTTP ${response.status}; records remain in the local outbox`);
          if (response.status === 408 || response.status === 429 || response.status >= 500) {
            this.retry(retryAfterMs(response.headers.get("retry-after")));
          } else {
            this.blocked = true; // Configuration errors need operator action, not a retry loop.
          }
          return;
        }
        // Remove only after acceptance. A crash before deletion safely resends the same bytes.
        unlinkSync(batch.path);
        this.batches.shift();
        this.acceptedRecords += batch.count;
        this.failures = 0;
        this.lastError = undefined;
      } catch {
        this.report("OTLP transport or outbox error; records remain pending");
        this.retry();
        return;
      } finally {
        this.controller = undefined;
      }
    }
  }

  async flush(timeoutMs = this.config.shutdownTimeoutMs): Promise<ExporterStatus> {
    this.persist();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    // An explicit flush is also a manual retry for a previously blocked endpoint.
    this.blocked = false;
    this.kick();
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([
      this.worker,
      new Promise<void>((resolve) => { deadline = setTimeout(resolve, timeoutMs); }),
    ]);
    if (deadline) clearTimeout(deadline);
    return this.status();
  }

  async close(): Promise<void> {
    if (this.stopped || this.closing) return;
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    try {
      await this.flush();
    } finally {
      this.stopped = true;
      this.controller?.abort();
      await this.worker;
      // PID 0 makes retained batches reclaimable by /reload in this same process.
      for (const directory of this.directories) {
        if (!readdirSync(directory).length) rmdirSync(directory);
        else renameSync(directory, join(this.config.spoolDir, `0-${randomUUID()}`));
      }
    }
  }
}

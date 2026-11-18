/**
 * P0-03 / REF-05: the single, process-wide download scheduler.
 *
 * All resource-package requests (Free, Pro, selected resources, warmup and
 * bitmap shards) go through this scheduler. The hard ceiling is 3 active
 * *package* requests per CLI process; a smaller configured value is allowed but
 * never larger. Metadata requests are small, bounded separately (default 4) and
 * do not consume a package slot.
 *
 * Retries and redirects re-enter the scheduler for each network attempt, so
 * backoff never holds a slot. Multiple CLI processes are independent by design;
 * there is no cross-process accounting.
 */

export type DownloadKind = "package" | "metadata";

export const MAX_PACKAGE_CONCURRENCY = 3;
export const DEFAULT_METADATA_CONCURRENCY = 4;

export interface DownloadSchedulerStats {
  readonly packageActive: number;
  readonly packagePeak: number;
  readonly packageQueued: number;
  readonly metadataActive: number;
  readonly metadataPeak: number;
  readonly metadataQueued: number;
  readonly completed: number;
  readonly failed: number;
}

export interface DownloadScheduler {
  readonly run: <T>(kind: DownloadKind, task: () => Promise<T>) => Promise<T>;
  /**
   * Low-level slot ownership for code whose control flow uses early returns
   * (e.g. selected-resource ranges). The caller MUST release in `finally`.
   */
  readonly acquire: (kind: DownloadKind) => Promise<() => void>;
  readonly stats: () => DownloadSchedulerStats;
}

interface Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
}

class SlotPool {
  private active = 0;
  private peak = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limit: number) {}

  get activeCount(): number {
    return this.active;
  }

  get peakCount(): number {
    return this.peak;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      const reason: unknown = signal.reason;
      return Promise.reject(reason instanceof Error ? reason : new Error("cancelled"));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      });
    }
  }
}

export interface SchedulerOptions {
  /** 1..3; values above the frozen hard cap are clamped to 3. */
  readonly packageConcurrency?: number;
  readonly metadataConcurrency?: number;
}

export function createDownloadScheduler(options: SchedulerOptions = {}): DownloadScheduler {
  const requested = options.packageConcurrency ?? MAX_PACKAGE_CONCURRENCY;
  const packageLimit = Math.max(1, Math.min(MAX_PACKAGE_CONCURRENCY, Math.floor(requested)));
  const metadataLimit = Math.max(
    1,
    Math.min(16, Math.floor(options.metadataConcurrency ?? DEFAULT_METADATA_CONCURRENCY)),
  );
  const packages = new SlotPool(packageLimit);
  const metadata = new SlotPool(metadataLimit);
  let completed = 0;
  let failed = 0;

  return {
    acquire(kind: DownloadKind) {
      return (kind === "metadata" ? metadata : packages).acquire();
    },
    async run<T>(kind: DownloadKind, task: () => Promise<T>): Promise<T> {
      const pool = kind === "metadata" ? metadata : packages;
      const release = await pool.acquire();
      try {
        const result = await task();
        completed += 1;
        return result;
      } catch (error) {
        failed += 1;
        throw error;
      } finally {
        release();
      }
    },
    stats() {
      return {
        packageActive: packages.activeCount,
        packagePeak: packages.peakCount,
        packageQueued: packages.queuedCount,
        metadataActive: metadata.activeCount,
        metadataPeak: metadata.peakCount,
        metadataQueued: metadata.queuedCount,
        completed,
        failed,
      };
    },
  };
}

let singleton: DownloadScheduler | undefined;

/** The one scheduler a CLI process creates on first download. */
export function getDownloadScheduler(): DownloadScheduler {
  singleton ??= createDownloadScheduler();
  return singleton;
}

/** Test/embedding seam: replace the process scheduler (never used by commands). */
export function setDownloadScheduler(scheduler: DownloadScheduler | undefined): void {
  singleton = scheduler;
}

export function resetDownloadScheduler(): void {
  singleton = undefined;
}

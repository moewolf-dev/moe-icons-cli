/**
 * DEV-G08 (DEC-101/104/107): frozen bitmap shard resource budget interface.
 *
 * These are conservative interim values used until `OPS-05-05` measures the
 * real six-shard matrix; `AUD-FIX-30` then freezes the production defaults.
 * No consumer may invent its own limit — every shard download/expand path takes
 * its numbers from here, and the legacy `ICON_ARCHIVE_MAX_EXPANDED_BYTES`
 * 512 MiB aggregate cap is deliberately not a shard budget.
 */
export interface BitmapShardBudget {
  /** Largest signed compressed shard archive accepted for one tuple. */
  readonly compressedBytes: number;
  /** Largest expanded (uncompressed) shard archive accepted. */
  readonly expandedBytes: number;
  /** Largest number of archive entries (manifest + icons) in one shard. */
  readonly entries: number;
  /** Largest single uncompressed icon payload accepted. */
  readonly singleFileBytes: number;
  /** Largest aggregate downloaded bytes for one generate/install resolve. */
  readonly totalDownloadBytes: number;
  /** Reserved temporary disk headroom for staging one shard at a time. */
  readonly tempDiskBytes: number;
  /** Frozen concurrency; shards are always fetched one at a time. */
  readonly concurrency: 1;
  /** Per-shard descriptor request timeout. */
  readonly descriptorTimeoutMs: number;
  /** Per-shard payload download timeout. */
  readonly downloadTimeoutMs: number;
}

export const BITMAP_SHARD_BUDGET: BitmapShardBudget = Object.freeze({
  compressedBytes: 64 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  entries: 2000,
  singleFileBytes: 16 * 1024 * 1024,
  totalDownloadBytes: 512 * 1024 * 1024,
  tempDiskBytes: 256 * 1024 * 1024,
  concurrency: 1,
  descriptorTimeoutMs: 5_000,
  downloadTimeoutMs: 60_000,
});

/** Backwards-compatible aliases kept for the frozen shard contract. */
export const BITMAP_SHARD_MAX_ENTRIES = BITMAP_SHARD_BUDGET.entries;
export const BITMAP_SHARD_MAX_EXPANDED_BYTES = BITMAP_SHARD_BUDGET.expandedBytes;

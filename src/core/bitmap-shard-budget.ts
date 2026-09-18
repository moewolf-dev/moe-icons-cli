/**
 * DEV-G08 (DEC-101/104/107): frozen bitmap shard resource budget interface.
 *
 * Values are calibrated from the OPS-04-06 real v4 release measurement
 * (release 0.0.17, `moe-3d-metal` six shards):
 *   - 512x512/png: 93,843,123 compressed / 94,408,209 expanded (largest)
 *   - 256x256/png: 25,539,799 / 25,620,204
 *   - 128x128/png:  7,792,540 /  7,828,646
 *   - 512x512/webp: 8,668,836 /  8,932,948
 *   - 256x256/webp: 3,575,782 /  3,800,040
 *   - 128x128/webp: 1,599,168 /  1,829,146
 * The largest single icon payload was 338,828 B and the aggregate six-shard
 * download was 141,019,248 B. `compressedBytes`/`expandedBytes` therefore allow
 * the measured 89.5/90.0 MiB worst case with headroom; `AUD-FIX-30` records the
 * production freeze. No consumer may invent its own limit — every shard
 * download/expand path takes its numbers from here, and the legacy
 * `ICON_ARCHIVE_MAX_EXPANDED_BYTES` 512 MiB aggregate cap is deliberately not a
 * shard budget.
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
  compressedBytes: 128 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  entries: 2000,
  singleFileBytes: 16 * 1024 * 1024,
  totalDownloadBytes: 512 * 1024 * 1024,
  tempDiskBytes: 256 * 1024 * 1024,
  concurrency: 1,
  descriptorTimeoutMs: 5_000,
  // The largest measured production shard is about 94 MiB. A one-minute
  // timeout rejects healthy downloads below roughly 13 Mbit/s.
  downloadTimeoutMs: 120_000,
});

/** Backwards-compatible aliases kept for the frozen shard contract. */
export const BITMAP_SHARD_MAX_ENTRIES = BITMAP_SHARD_BUDGET.entries;
export const BITMAP_SHARD_MAX_EXPANDED_BYTES = BITMAP_SHARD_BUDGET.expandedBytes;

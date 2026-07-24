/**
 * Hybrid logical clock, wire-compatible with the Kotlin client and shoal
 * PROTOCOL.md: 12 hex chars wall-clock ms, 4 hex counter, 8 hex node id,
 * dash-separated. Lexicographic order equals causal order, so LWW merge is
 * plain string comparison.
 */
export class Hlc {
  private lastMs = 0;
  private counter = 0;

  constructor(private readonly nodeId: number) {}

  /** Next stamp, monotonic across same-ms bursts and backwards clock steps. */
  next(wallMs: number = Date.now()): string {
    if (wallMs > this.lastMs) {
      this.lastMs = wallMs;
      this.counter = 0;
    } else {
      this.counter++;
      if (this.counter > 0xffff) {
        this.lastMs++;
        this.counter = 0;
      }
    }
    return Hlc.encode(this.lastMs, this.counter, this.nodeId);
  }

  /** Fold a remote stamp in so the next local write sorts after it. */
  observe(remote: string): void {
    const remoteMs = parseInt(remote.split("-")[0] ?? "", 16);
    if (Number.isFinite(remoteMs) && remoteMs > this.lastMs) {
      this.lastMs = remoteMs;
      this.counter = 0;
    }
  }

  static encode(ms: number, counter: number, nodeId: number): string {
    const msHex = ms.toString(16).padStart(12, "0");
    const counterHex = counter.toString(16).padStart(4, "0");
    const nodeHex = (nodeId >>> 0).toString(16).padStart(8, "0");
    return `${msHex}-${counterHex}-${nodeHex}`;
  }

  static isNewer(candidate: string, current: string | undefined | null): boolean {
    return current == null || candidate > current;
  }
}

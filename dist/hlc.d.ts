/**
 * Hybrid logical clock, wire-compatible with the Kotlin client and shoal
 * PROTOCOL.md: 12 hex chars wall-clock ms, 4 hex counter, 8 hex node id,
 * dash-separated. Lexicographic order equals causal order, so LWW merge is
 * plain string comparison.
 */
export declare class Hlc {
    private readonly nodeId;
    private lastMs;
    private counter;
    constructor(nodeId: number);
    /** Next stamp, monotonic across same-ms bursts and backwards clock steps. */
    next(wallMs?: number): string;
    /** Fold a remote stamp in so the next local write sorts after it. */
    observe(remote: string): void;
    static encode(ms: number, counter: number, nodeId: number): string;
    static isNewer(candidate: string, current: string | undefined | null): boolean;
}

// Single-threaded heartbeat loop. Fires every heartbeatMs and
// calls tick() on every bot in registration order. Backpressure
// warning if average tick runtime creeps past half the budget.

import type { Bot } from './bot.js';

export class Scheduler {
    private timer: NodeJS.Timeout | null = null;
    private runtimeSamples: number[] = [];
    private readonly sampleWindow = 100;
    private lastSaturationWarnAt = 0;

    constructor(private readonly bots: Bot[], private readonly heartbeatMs: number) {}

    start(): void {
        for (const b of this.bots) b.start();
        this.timer = setInterval(() => this.tick(), this.heartbeatMs);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        for (const b of this.bots) b.stop();
    }

    private tick(): void {
        const t0 = performance.now();
        for (const b of this.bots) {
            try {
                b.tick();
            } catch (err) {
                console.error(`[scheduler] bot ${b.name} on ${b.remoteName} threw:`, err);
            }
        }
        const dt = performance.now() - t0;
        this.recordRuntime(dt);
    }

    private recordRuntime(dt: number): void {
        this.runtimeSamples.push(dt);
        if (this.runtimeSamples.length > this.sampleWindow) {
            this.runtimeSamples.shift();
        }
        if (this.runtimeSamples.length < this.sampleWindow) return;
        const avg = this.runtimeSamples.reduce((a, b) => a + b, 0) / this.runtimeSamples.length;
        const half = this.heartbeatMs / 2;
        const now = Date.now();
        // Rate-limit the warning to once every 10 s so a long
        // saturation episode doesn't spam the log.
        if (avg > half && now - this.lastSaturationWarnAt > 10_000) {
            console.warn(
                `[scheduler] average tick runtime ${avg.toFixed(1)}ms exceeds ${half}ms ` +
                `(${this.heartbeatMs}ms budget, ${this.bots.length} bots)`
            );
            this.lastSaturationWarnAt = now;
        }
    }
}

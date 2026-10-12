// Entrypoint. Loads config, builds one Bot per configured
// instance across every configured remote, hands them to the
// Scheduler, and installs a SIGINT handler for clean shutdown.

import { loadConfig } from './config.js';
import { Bot } from './bot.js';
import { Scheduler } from './scheduler.js';

function main(): void {
    const config = loadConfig();
    const bots: Bot[] = [];
    for (const remote of config.remotes) {
        for (const bc of remote.bots) {
            bots.push(new Bot({ remoteName: remote.name, remoteUrl: remote.url, config: bc }));
        }
    }
    if (bots.length === 0) {
        console.error('[game-bots] config has no bots to run');
        process.exitCode = 1;
        return;
    }
    const scheduler = new Scheduler(bots, config.heartbeatMs);

    const shutdown = (signal: string): void => {
        console.log(`[game-bots] received ${signal}, shutting down ${bots.length} bots`);
        scheduler.stop();
        setTimeout(() => process.exit(0), 500).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    console.log(
        `[game-bots] starting ${bots.length} bot(s) across ${config.remotes.length} remote(s) ` +
        `at ${config.heartbeatMs}ms heartbeat`
    );
    scheduler.start();
}

main();

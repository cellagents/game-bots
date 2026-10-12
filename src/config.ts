// Config loader. Resolves the config in this order:
//
//   1. $GAME_BOTS_INLINE_CONFIG          raw JSON string in env
//   2. $GAME_BOTS_CONFIG                 absolute path override
//   3. <repo-root>/config.json           user-managed, gitignored
//   4. <repo-root>/config.example.json   checked-in defaults
//
// Inline wins over file path on purpose: a docker-compose author
// embedding the roster in the compose file does not want a stray
// config.json in the image to mask it. Validates the shape and
// clamps the per-bot personality knobs into [0, 1].

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BotConfig {
    name: string;
    aggressiveness: number;
    splitWillingness: number;
    cowardice: number;
}

export interface RemoteConfig {
    name: string;
    url: string;
    bots: BotConfig[];
}

export interface Config {
    heartbeatMs: number;
    remotes: RemoteConfig[];
}

const KNOBS = ['aggressiveness', 'splitWillingness', 'cowardice'] as const;
const BOT_KEYS = new Set<string>(['name', ...KNOBS]);
const REMOTE_KEYS = new Set<string>(['name', 'url', 'bots']);
const ROOT_KEYS = new Set<string>(['heartbeatMs', 'remotes']);

export function loadConfig(): Config {
    const inline = process.env.GAME_BOTS_INLINE_CONFIG;
    if (inline !== undefined && inline !== '') {
        let parsed: unknown;
        try {
            parsed = JSON.parse(inline);
        } catch (err) {
            throw new Error(
                '$GAME_BOTS_INLINE_CONFIG is not valid JSON: '
                + (err instanceof Error ? err.message : String(err))
            );
        }
        return validate(parsed, '$GAME_BOTS_INLINE_CONFIG');
    }

    // src/config.ts → dist/config.js; repo root is one dir up.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..');
    const envPath = process.env.GAME_BOTS_CONFIG;
    const candidates = [
        envPath,
        path.resolve(repoRoot, 'config.json'),
        path.resolve(repoRoot, 'config.example.json')
    ].filter((p): p is string => typeof p === 'string');

    let raw: unknown = null;
    let source: string | null = null;
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            source = p;
            break;
        }
    }
    if (!raw) {
        throw new Error(
            'No game-bots config found; set GAME_BOTS_INLINE_CONFIG, '
            + 'set GAME_BOTS_CONFIG, or create config.json / config.example.json'
        );
    }
    return validate(raw, source!);
}

function validate(raw: unknown, source: string): Config {
    if (!isPlainObject(raw)) {
        throw new Error(`Config at ${source} must be a JSON object`);
    }
    rejectUnknown(raw, ROOT_KEYS, source, '(root)');

    const heartbeatMs = typeof raw.heartbeatMs === 'number' && raw.heartbeatMs > 0
        ? raw.heartbeatMs
        : 100;

    if (!Array.isArray(raw.remotes) || raw.remotes.length === 0) {
        throw new Error(`Config at ${source} must list at least one remote under 'remotes'`);
    }

    const remotes: RemoteConfig[] = raw.remotes.map((r, i) => validateRemote(r, source, i));

    return { heartbeatMs, remotes };
}

function validateRemote(raw: unknown, source: string, i: number): RemoteConfig {
    const where = `remotes[${i}]`;
    if (!isPlainObject(raw)) {
        throw new Error(`Config at ${source} ${where} must be an object`);
    }
    rejectUnknown(raw, REMOTE_KEYS, source, where);
    if (typeof raw.name !== 'string' || raw.name.length === 0) {
        throw new Error(`Config at ${source} ${where}.name must be a non-empty string`);
    }
    if (typeof raw.url !== 'string' || raw.url.length === 0) {
        throw new Error(`Config at ${source} ${where}.url must be a non-empty string`);
    }
    if (!Array.isArray(raw.bots) || raw.bots.length === 0) {
        throw new Error(`Config at ${source} ${where}.bots must be a non-empty array`);
    }
    const bots = raw.bots.map((b, j) => validateBot(b, source, `${where}.bots[${j}]`));
    return { name: raw.name, url: raw.url, bots };
}

/** Protocol 1.0 player-name regex: letters, digits, underscores,
 *  1..25 chars. Matches the server's NameSchema; validating here
 *  turns a silent reject-loop (every subscribe gets INVALID_NAME,
 *  bot never joins) into a loud startup error. */
const NAME_REGEX = /^[\p{L}\p{N}_]{1,25}$/u;

function validateBot(raw: unknown, source: string, where: string): BotConfig {
    if (!isPlainObject(raw)) {
        throw new Error(`Config at ${source} ${where} must be an object`);
    }
    rejectUnknown(raw, BOT_KEYS, source, where);
    if (typeof raw.name !== 'string' || raw.name.length === 0) {
        throw new Error(`Config at ${source} ${where}.name must be a non-empty string`);
    }
    if (!NAME_REGEX.test(raw.name)) {
        throw new Error(
            `Config at ${source} ${where}.name = '${raw.name}' is invalid: `
            + 'protocol 1.0 names must match /^[\\p{L}\\p{N}_]{1,25}$/u '
            + '(letters, digits, underscore; no hyphens or spaces)'
        );
    }
    const bot: BotConfig = {
        name: raw.name,
        aggressiveness: clamp01(raw, 'aggressiveness', source, where),
        splitWillingness: clamp01(raw, 'splitWillingness', source, where),
        cowardice: clamp01(raw, 'cowardice', source, where)
    };
    return bot;
}

function clamp01(raw: Record<string, unknown>, key: string, source: string, where: string): number {
    const v = raw[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`Config at ${source} ${where}.${key} must be a finite number in [0, 1]`);
    }
    if (v < 0 || v > 1) {
        console.warn(`[config] ${where}.${key} = ${v} is outside [0, 1]; clamping`);
        return Math.max(0, Math.min(1, v));
    }
    return v;
}

function rejectUnknown(obj: Record<string, unknown>, allowed: Set<string>, source: string, where: string): void {
    for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
            throw new Error(`Config at ${source} ${where} has unknown key '${key}'`);
        }
    }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

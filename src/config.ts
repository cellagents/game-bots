// Config loader. Reads a JSON file from one of several candidate
// paths, validates the shape, and clamps the per-bot personality
// knobs into [0, 1]. Candidate order (first that exists wins):
//
//   1. $GAME_BOTS_CONFIG                 explicit override
//   2. <repo-root>/config.json           user-managed, gitignored
//   3. <repo-root>/config.example.json   checked-in defaults

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
            'No game-bots config file found; set GAME_BOTS_CONFIG or create config.json / config.example.json'
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

function validateBot(raw: unknown, source: string, where: string): BotConfig {
    if (!isPlainObject(raw)) {
        throw new Error(`Config at ${source} ${where} must be an object`);
    }
    rejectUnknown(raw, BOT_KEYS, source, where);
    if (typeof raw.name !== 'string' || raw.name.length === 0) {
        throw new Error(`Config at ${source} ${where}.name must be a non-empty string`);
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

/**
 * Paseo overlay: origin and attention state from Paseo's per-agent records.
 *
 * Paseo (the desktop agent orchestrator) keeps one JSON record per agent
 * under `~/.paseo/agents/<workspace-dir>/<agentId>.json`. This loader
 * extracts the three facts the registry sync joins on:
 *
 * - the provider-native session id at `.persistence.sessionId`, falling
 *   back to `.runtimeInfo.sessionId` — it must match the registry's provider
 *   session id verbatim (e.g. kimi `session_<uuid>`, claude UUID);
 * - `.requiresAttention`, defaulting to false when absent;
 * - `.parentAgentId` (present → the agent is a subagent);
 * - `.id` and `.provider`, the latter validated against the canonical
 *   provider keys — records naming an unknown provider are skipped.
 *
 * Every read flows through injected filesystem dependencies, and results are
 * cached per file on the (mtime, size) identity, so a pass over unchanged
 * records costs one stat each (mirroring the titles resolver's Claude
 * transcript cache). The loader never throws: a missing agents directory
 * yields an empty list, and malformed or incomplete records are skipped
 * without voiding the pass.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_KEYS, type Provider } from "../protocol";

const MAX_STRING_CODE_POINTS = 256;
const PROVIDERS: ReadonlySet<string> = new Set(PROVIDER_KEYS);

export type PaseoAgentState = {
  provider: string;
  sessionId: string;
  agentId: string;
  requiresAttention: boolean;
  isSubagent: boolean;
};

export type PaseoFileStat = { mtimeMs: number; size: number };

export type PaseoLoaderDependencies = {
  readWhole?: (path: string) => string | null;
  listFiles?: (dir: string) => string[];
  statPath?: (path: string) => PaseoFileStat | null;
};

/**
 * The provider field crosses from untrusted JSON (a plain `string`) into the
 * registry sync (whose parameter narrows to `Provider`); this predicate
 * carries the loader's runtime validation — records with unknown providers
 * are skipped before they ever leave it — across that boundary.
 */
export const isKnownProviderState = (state: PaseoAgentState): state is PaseoAgentState & { provider: Provider } =>
  PROVIDERS.has(state.provider);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundString = (value: string): string => Array.from(value).slice(0, MAX_STRING_CODE_POINTS).join("");

/** The provider-native session id at `container`.sessionId, or null when absent. */
const sessionIdFrom = (value: Record<string, unknown>, container: string): string | null => {
  const nested = value[container];
  if (!isRecord(nested)) {
    return null;
  }
  const sessionId = nested["sessionId"];
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
};

/** Extract one agent record's overlay facts, or null when it must be skipped. */
const parseAgentRecord = (value: unknown): PaseoAgentState | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = value["id"];
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  const provider = value["provider"];
  if (typeof provider !== "string" || !PROVIDERS.has(provider)) {
    return null;
  }
  const sessionId = sessionIdFrom(value, "persistence") ?? sessionIdFrom(value, "runtimeInfo");
  if (sessionId === null) {
    return null;
  }
  const parentAgentId = value["parentAgentId"];
  return {
    provider,
    sessionId: boundString(sessionId),
    agentId: boundString(id),
    requiresAttention: value["requiresAttention"] === true,
    isSubagent: typeof parentAgentId === "string" && parentAgentId.length > 0,
  };
};

const defaultStatPath = (path: string): PaseoFileStat | null => {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
};

const defaultReadWhole = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** A missing or unreadable directory lists as empty; the loader never throws. */
const defaultListFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

export const createPaseoAgentStateLoader = (dependencies: PaseoLoaderDependencies = {}) => {
  const statPath = dependencies.statPath ?? defaultStatPath;
  const readWhole = dependencies.readWhole ?? defaultReadWhole;
  const listFiles = dependencies.listFiles ?? defaultListFiles;
  const cache = new Map<string, PaseoFileStat & { state: PaseoAgentState | null }>();

  const readAgentFile = (path: string): PaseoAgentState | null => {
    const stat = statPath(path);
    if (stat === null) {
      return null;
    }
    const cached = cache.get(path);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.state;
    }
    let state: PaseoAgentState | null = null;
    const content = readWhole(path);
    if (content !== null) {
      try {
        state = parseAgentRecord(JSON.parse(content));
      } catch {
        // Malformed JSON is skipped like any other unparseable record.
        state = null;
      }
    }
    cache.set(path, { ...stat, state });
    return state;
  };

  return (paseoDir: string): PaseoAgentState[] => {
    const states: PaseoAgentState[] = [];
    for (const workspace of listFiles(paseoDir)) {
      const workspaceDir = join(paseoDir, workspace);
      for (const entry of listFiles(workspaceDir)) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        const state = readAgentFile(join(workspaceDir, entry));
        if (state !== null) {
          states.push(state);
        }
      }
    }
    return states;
  };
};

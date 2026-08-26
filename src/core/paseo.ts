/**
 * Paseo overlay: origin and attention state from Paseo's per-agent records.
 *
 * Paseo (the desktop agent orchestrator) keeps one JSON record per agent
 * under `~/.paseo/agents/<workspace-dir>/<agentId>.json`. This loader
 * extracts the three facts the registry sync joins on:
 *
 * - the current provider-native session id at `.runtimeInfo.sessionId`, falling
 *   back to `.persistence.sessionId` for records without runtime identity — it
 *   must match the registry's provider session id verbatim (e.g. kimi
 *   `session_<uuid>`, claude UUID);
 * - `.requiresAttention`, defaulting to false when absent;
 * - `.archivedAt`, the optional archive stamp the registry sync treats as
 *   viewed-equivalent;
 * - `.attentionTimestamp` and `.updatedAt`, both optional ISO-8601 strings
 *   bounded like every other record string, then validated and re-emitted in
 *   canonical UTC form (`Date.parse` + `toISOString`, unparseable → null) —
 *   the registry sync's attention watermark compares them lexically against
 *   `unread_since`, which only works when both sides are canonical;
 * - parentage: `.labels["paseo.parent-agent-id"]` is where Paseo persists
 *   the dispatching agent's id (present → the agent is a subagent); a
 *   top-level `.parentAgentId` is honored as a fallback — the id itself is
 *   carried as `parentAgentId` so the registry sync can stamp
 *   `origin_parent_ref`;
 * - `.id` and `.provider`, the latter validated against the canonical
 *   provider keys — records naming an unknown provider are skipped;
 * - `.lastStatus`, Paseo's persisted lifecycle, validated against Paseo's
 *   vocabulary (unknown values → null) — the registry sync uses a settled
 *   value as proof that a stuck working row's turn-end was missed.
 *
 * Every read flows through injected filesystem dependencies, and results are
 * cached per file on the (mtime, size) identity, so a pass over unchanged
 * records costs one stat each (mirroring the titles resolver's Claude
 * transcript cache). Entries for files missing from a pass are evicted, so
 * deleted agents never accumulate in the long-lived daemon. The loader never
 * throws: a missing agents directory yields an empty list, and malformed or
 * incomplete records are skipped without voiding the pass.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_KEYS, type Provider } from "../protocol";

const MAX_STRING_CODE_POINTS = 256;
const MAX_TITLE_CODE_POINTS = 256;
const PROVIDERS: ReadonlySet<string> = new Set(PROVIDER_KEYS);

/** Paseo's agent lifecycle vocabulary as persisted in a record's `lastStatus`. */
export type PaseoAgentStatus = "initializing" | "idle" | "running" | "error" | "closed";

export type PaseoAgentState = {
  provider: string;
  sessionId: string;
  agentId: string;
  requiresAttention: boolean;
  isSubagent: boolean;
  /** The dispatching agent's id (labels["paseo.parent-agent-id"], top-level parentAgentId fallback), or null. */
  parentAgentId: string | null;
  attentionTimestamp: string | null;
  updatedAt: string | null;
  /** When the user archived the agent in Paseo (ISO-8601 UTC), or null while live. */
  archivedAt: string | null;
  title: string | null;
  /** Paseo's persisted lifecycle (`lastStatus`), or null when absent or unrecognized. */
  lastStatus: PaseoAgentStatus | null;
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

const boundTitle = (value: string): string => Array.from(value).slice(0, MAX_TITLE_CODE_POINTS).join("");

/** A bounded, canonical UTC ISO-8601 timestamp, or null when absent, non-string, or unparseable. */
const isoTimestampFrom = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(boundString(value));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

/** The provider-native session id at `container`.sessionId, or null when absent. */
const sessionIdFrom = (value: Record<string, unknown>, container: string): string | null => {
  const nested = value[container];
  if (!isRecord(nested)) {
    return null;
  }
  const sessionId = nested["sessionId"];
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
};

const PASEO_AGENT_STATUSES: ReadonlySet<string> = new Set(["initializing", "idle", "running", "error", "closed"]);

/** The record's persisted lifecycle, or null when absent or outside Paseo's vocabulary. */
const lastStatusFrom = (value: unknown): PaseoAgentStatus | null =>
  typeof value === "string" && PASEO_AGENT_STATUSES.has(value) ? (value as PaseoAgentStatus) : null;

const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

/**
 * Paseo persists the dispatching agent's id in the record's labels map; a
 * top-level `parentAgentId` field is honored as a fallback. Either one
 * present and non-empty marks the agent as a subagent.
 */
const parentAgentIdFrom = (value: Record<string, unknown>): string | null => {
  const labels = value["labels"];
  if (isRecord(labels)) {
    const labeled = labels[PARENT_AGENT_ID_LABEL];
    if (typeof labeled === "string" && labeled.length > 0) {
      return labeled;
    }
  }
  const topLevel = value["parentAgentId"];
  return typeof topLevel === "string" && topLevel.length > 0 ? topLevel : null;
};

/** Extract the user-visible title from a Paseo agent record. */
const titleFrom = (value: Record<string, unknown>): string | null => {
  // Paseo renames update the top-level title but leave the original title in
  // the nested provider metadata, so the user-visible value is authoritative.
  const topLevelTitle = value["title"];
  if (typeof topLevelTitle === "string" && topLevelTitle.length > 0) {
    return boundTitle(topLevelTitle);
  }

  const runtimeInfo = value["runtimeInfo"];
  if (isRecord(runtimeInfo)) {
    const extra = runtimeInfo["extra"];
    if (isRecord(extra)) {
      const extraTitle = extra["title"];
      if (typeof extraTitle === "string" && extraTitle.length > 0) {
        return boundTitle(extraTitle);
      }
    }
  }
  const persistence = value["persistence"];
  if (isRecord(persistence)) {
    const metadata = persistence["metadata"];
    if (isRecord(metadata)) {
      const metadataTitle = metadata["title"];
      if (typeof metadataTitle === "string" && metadataTitle.length > 0) {
        return boundTitle(metadataTitle);
      }
    }
  }
  return null;
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
  const sessionId = sessionIdFrom(value, "runtimeInfo") ?? sessionIdFrom(value, "persistence");
  if (sessionId === null) {
    return null;
  }
  const parentAgentId = parentAgentIdFrom(value);
  return {
    provider,
    sessionId: boundString(sessionId),
    agentId: boundString(id),
    requiresAttention: value["requiresAttention"] === true,
    isSubagent: parentAgentId !== null,
    parentAgentId: parentAgentId === null ? null : boundString(parentAgentId),
    attentionTimestamp: isoTimestampFrom(value["attentionTimestamp"]),
    updatedAt: isoTimestampFrom(value["updatedAt"]),
    archivedAt: isoTimestampFrom(value["archivedAt"]),
    title: titleFrom(value),
    lastStatus: lastStatusFrom(value["lastStatus"]),
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
    const seen = new Set<string>();
    for (const workspace of listFiles(paseoDir)) {
      const workspaceDir = join(paseoDir, workspace);
      for (const entry of listFiles(workspaceDir)) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        const path = join(workspaceDir, entry);
        seen.add(path);
        const state = readAgentFile(path);
        if (state !== null) {
          states.push(state);
        }
      }
    }
    // Evict entries for files this pass did not see — deleted agent records
    // must not accumulate in the cache over the daemon's lifetime.
    for (const path of cache.keys()) {
      if (!seen.has(path)) {
        cache.delete(path);
      }
    }
    return states;
  };
};

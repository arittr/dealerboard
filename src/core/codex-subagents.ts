/**
 * Resolve native Codex children from the local thread index and their rollouts.
 * Hooks establish prompt membership quickly; recorded turns reconcile missed
 * stops and rediscover resumed children under registered parents. No age-based
 * inference is made: a terminal event must match the latest started turn.
 */
import { Database } from "bun:sqlite";
import { open } from "node:fs/promises";

export type CodexSubagent = {
  sessionId: string;
  parentSessionId: string;
  title: string | null;
  model: string | null;
  transcriptPath: string;
  turn: { id: string; startedAt: string; observedAt: string; status: "working" | "stopped" } | null;
};

type RolloutState = {
  inode: number;
  device: number;
  size: number;
  mtimeMs: number;
  offset: number;
  skippingLine: boolean;
  sessionId: string | null;
  turn: CodexSubagent["turn"];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bounded = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? Array.from(value.trim()).slice(0, 256).join("") : null;
const timestamp = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

const consumeLine = (state: RolloutState, line: string): void => {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(record) || !isRecord(record["payload"])) return;
  const payload = record["payload"];
  if (record["type"] === "session_meta") {
    state.sessionId = bounded(payload["id"]);
    state.turn = null;
    return;
  }
  const observedAt = timestamp(record["timestamp"]);
  if (
    record["type"] === "response_item" &&
    state.turn?.status === "working" &&
    observedAt !== null &&
    observedAt > state.turn.observedAt
  ) {
    state.turn = { ...state.turn, observedAt };
  }
  if (record["type"] !== "event_msg") return;
  const id = bounded(payload["turn_id"]);
  const at = timestamp(record["timestamp"]);
  if (id === null || at === null) return;
  if (payload["type"] === "task_started") {
    if (state.turn === null || at >= state.turn.startedAt) {
      state.turn = { id, startedAt: at, observedAt: at, status: "working" };
    }
  } else if (
    (payload["type"] === "task_complete" || payload["type"] === "turn_aborted") &&
    state.turn?.id === id &&
    at >= state.turn.observedAt
  ) {
    state.turn = { ...state.turn, observedAt: at, status: "stopped" };
  }
};

/**
 * Incremental reads retain only identity, offsets and turn facts. A pass reads
 * at most 4 MiB per rollout; until it reaches a complete, unchanged EOF it
 * cannot assert lifecycle state. Incomplete final lines are retried next pass.
 */
const READ_BUDGET = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;

export const createCodexSubagentResolver = (databasePath: string) => {
  const cache = new Map<string, RolloutState>();
  const readTurn = async (path: string, sessionId: string): Promise<CodexSubagent["turn"]> => {
    let file: Awaited<ReturnType<typeof open>> | null = null;
    try {
      file = await open(path, "r");
      const stat = await file.stat();
      const previous = cache.get(path);
      const state: RolloutState =
        previous !== undefined &&
        previous.inode === stat.ino &&
        previous.device === stat.dev &&
        stat.size >= previous.size &&
        (stat.size !== previous.size || stat.mtimeMs === previous.mtimeMs)
          ? { ...previous }
          : {
              inode: stat.ino,
              device: stat.dev,
              offset: 0,
              skippingLine: false,
              sessionId: null,
              turn: null,
              size: 0,
              mtimeMs: 0,
            };
      let position = state.offset;
      const end = Math.min(stat.size, position + READ_BUDGET);
      const buffer = Buffer.alloc(64 * 1024);
      let parts: Buffer[] = [];
      let lineBytes = state.skippingLine ? MAX_LINE_BYTES + 1 : 0;
      while (position < end) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - position), position);
        if (bytesRead === 0) break;
        let start = 0;
        for (let i = 0; i < bytesRead; i += 1) {
          if (buffer[i] !== 10) continue;
          lineBytes += i - start;
          if (lineBytes <= MAX_LINE_BYTES) {
            parts.push(Buffer.from(buffer.subarray(start, i)));
            consumeLine(state, Buffer.concat(parts).toString("utf8"));
          }
          parts = [];
          lineBytes = 0;
          state.skippingLine = false;
          start = i + 1;
          state.offset = position + start;
        }
        lineBytes += bytesRead - start;
        if (lineBytes <= MAX_LINE_BYTES) parts.push(Buffer.from(buffer.subarray(start, bytesRead)));
        else parts = [];
        position += bytesRead;
        if (lineBytes > MAX_LINE_BYTES) {
          state.offset = position;
          state.skippingLine = true;
        }
      }
      state.size = stat.size;
      state.mtimeMs = stat.mtimeMs;
      cache.set(path, state);
      const after = await file.stat();
      if (
        state.skippingLine ||
        state.offset !== stat.size ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        state.sessionId !== sessionId
      )
        return null;
      return state.turn;
    } catch {
      cache.delete(path);
      return null;
    } finally {
      await file?.close();
    }
  };

  return async (parentIds: readonly string[]): Promise<CodexSubagent[]> => {
    if (parentIds.length === 0) {
      cache.clear();
      return [];
    }
    let db: Database | null = null;
    let rows: unknown[];
    try {
      db = new Database(databasePath, { readonly: true, create: false });
      // The source-prefix range uses Codex's source index. JSON parent ids
      // narrow the read to registered parents; normal user threads are excluded.
      rows = db
        .query(`SELECT id, agent_path, agent_nickname, model, rollout_path,
        json_extract(source, '$.subagent.thread_spawn.parent_thread_id') AS parent_id
        FROM threads WHERE source GLOB '{"subagent":*' AND json_valid(source)
        AND json_extract(source, '$.subagent.thread_spawn.parent_thread_id') IN (SELECT value FROM json_each(?))
        AND archived = 0`)
        .all(JSON.stringify(parentIds));
    } catch {
      return [];
    } finally {
      db?.close();
    }
    const children: CodexSubagent[] = [];
    const paths = new Set<string>();
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const sessionId = bounded(row["id"]);
      const parentSessionId = bounded(row["parent_id"]);
      const path = row["rollout_path"];
      if (sessionId === null || parentSessionId === null || typeof path !== "string" || path.length === 0) continue;
      paths.add(path);
      const task = typeof row["agent_path"] === "string" ? row["agent_path"].split("/").at(-1) : null;
      children.push({
        sessionId,
        parentSessionId,
        transcriptPath: path,
        title: bounded(task) ?? bounded(row["agent_nickname"]),
        model: bounded(row["model"]),
        turn: await readTurn(path, sessionId),
      });
    }
    for (const path of cache.keys()) if (!paths.has(path)) cache.delete(path);
    return children;
  };
};

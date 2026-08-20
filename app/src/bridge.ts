/** The webview's narrow call surface into the Rust host (see src-tauri/main.rs). */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Provider } from "../../src/protocol";

export type SnapshotPayload = { mtimeMs: number; contents: string };

export const readSnapshot = (): Promise<SnapshotPayload> => invoke<SnapshotPayload>("read_snapshot");

export const readQuotaSnapshot = (): Promise<SnapshotPayload> => invoke<SnapshotPayload>("read_quota_snapshot");

export const readPaseoServerId = (): Promise<string> => invoke<string>("read_paseo_server_id");

export const ackSession = (provider: Provider, sessionId: string): Promise<void> =>
  invoke<void>("ack_session", { provider, sessionId });

export const revealTranscript = (path: string): Promise<void> => invoke<void>("reveal_transcript", { path });

/** Destructive: deletes the session row. The action sheet confirms before calling this. */
export const clearSession = (provider: Provider, sessionId: string): Promise<void> =>
  invoke<void>("clear_session", { provider, sessionId });

export const openUrl = (url: string): Promise<void> => invoke<void>("open_url", { url });

export const focusGhostty = (script: string, terminalId: string): Promise<void> =>
  invoke<void>("focus_ghostty", { script, terminalId });

/**
 * Subscribe to the Rust host's file-watch push. The event name matches
 * SNAPSHOT_CHANGED_EVENT in src-tauri/main.rs; the payload shape is identical
 * to readSnapshot's result. Resolves to an unlisten fn — unused at app
 * lifetime. Requires no capability entry: core:default includes
 * core:event:allow-listen.
 */
export const onSnapshotChanged = (handler: (payload: SnapshotPayload) => void): Promise<UnlistenFn> =>
  listen<SnapshotPayload>("snapshot-changed", (event) => handler(event.payload));

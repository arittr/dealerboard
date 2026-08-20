/** The webview's narrow call surface into the Rust host (see src-tauri/main.rs). */

import { invoke } from "@tauri-apps/api/core";
import type { Provider } from "../../src/protocol";

export type SnapshotPayload = { mtimeMs: number; contents: string };

export const readSnapshot = (): Promise<SnapshotPayload> => invoke<SnapshotPayload>("read_snapshot");

export const readQuotaSnapshot = (): Promise<SnapshotPayload> => invoke<SnapshotPayload>("read_quota_snapshot");

export const readPaseoServerId = (): Promise<string> => invoke<string>("read_paseo_server_id");

export const ackSession = (provider: Provider, sessionId: string): Promise<void> =>
  invoke<void>("ack_session", { provider, sessionId });

export const openUrl = (url: string): Promise<void> => invoke<void>("open_url", { url });

export const focusGhostty = (script: string, terminalId: string): Promise<void> =>
  invoke<void>("focus_ghostty", { script, terminalId });

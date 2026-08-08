/**
 * Exact Kimi Web navigation behind a small injectable URL boundary.
 *
 * The fixed loopback origin targets the primary local Kimi Web server. The
 * opener delegates tab selection to the default browser and provides no
 * application-level acknowledgement that the requested session became visible.
 */

export type ActivateKimiSession = (sessionId: string) => Promise<void>;

export type OpenUrl = (url: string) => Promise<void>;

const KIMI_WEB_SESSIONS_URL = "http://127.0.0.1:58627/sessions/";

export const createKimiSessionActivator =
  (openUrl: OpenUrl): ActivateKimiSession =>
  (sessionId) =>
    openUrl(`${KIMI_WEB_SESSIONS_URL}${encodeURIComponent(sessionId)}`);

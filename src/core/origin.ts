/**
 * Spawner classification from the hook helper's own inherited environment.
 * The helper runs as a child of the harness process, so Paseo's spawn-env
 * marker and the terminal's TERM_PROGRAM survive into hook invocations.
 */
import type { SessionOrigin } from "../protocol";

const MAX_STRING_CODE_POINTS = 256;
const boundString = (value: string): string => Array.from(value).slice(0, MAX_STRING_CODE_POINTS).join("");

export const detectOrigin = (environment: Readonly<Record<string, string | undefined>>): SessionOrigin | null => {
  // The roborev marker is planted by the reviewer-spawn shim immediately at
  // spawn, so it is the most proximate evidence and outranks markers the
  // daemon inherited from whichever shell started it.
  const roborevMarker = environment["ROBOREV_SPAWN"]?.trim();
  if (roborevMarker !== undefined && roborevMarker.length > 0) {
    return { kind: "roborev", ref: boundString(roborevMarker) };
  }
  const paseoAgentId = environment["PASEO_AGENT_ID"]?.trim();
  if (paseoAgentId !== undefined && paseoAgentId.length > 0) {
    return { kind: "paseo", ref: boundString(paseoAgentId) };
  }
  const termProgram = environment["TERM_PROGRAM"]?.trim();
  if (termProgram !== undefined && termProgram.length > 0) {
    return { kind: "terminal", ref: boundString(termProgram) };
  }
  return null;
};

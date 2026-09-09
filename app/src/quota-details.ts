import { QUOTA_PROVIDER_KEYS, type QuotaProviderKey } from "../../src/quota-snapshot";
import {
  formatPercentRemaining,
  formatResetCountdown,
  type QuotaPanelModel,
  type QuotaTarget,
  quotaReadout,
} from "./quota";

export type QuotaDetailsModel = {
  target: QuotaTarget;
  title: string;
  activity: string;
  measurement: string;
  guidance: string | null;
  windows: readonly { tag: string; percent: string; reset: string }[];
};

const PROVIDER_LABELS: Record<QuotaProviderKey, string> = {
  claude: "Claude",
  codex: "Codex",
  kimi: "Kimi",
  zai: "GLM",
  qwen: "Qwen",
};

export function quotaDetailsModel(
  panels: readonly QuotaPanelModel[],
  target: QuotaTarget,
  now: number,
): QuotaDetailsModel | null {
  const panel = panels.find((entry) => entry.provider === target.provider);
  if (panel === undefined) return null;
  const account = target.accountId === null ? undefined : panel.accounts.find((entry) => entry.id === target.accountId);
  // An ambient reading is no longer a visible target once identified accounts exist.
  if (target.accountId === null ? panel.accounts.length > 0 : account === undefined) return null;
  const meter = account ?? panel;
  const age = meter.fetchedAtMs === null ? null : Math.max(0, Math.floor((now - meter.fetchedAtMs) / 60_000));
  const ageText =
    age === null ? "" : age < 60 ? `${age}m` : age < 1440 ? `${Math.floor(age / 60)}h` : `${Math.floor(age / 1440)}d`;
  const historical = quotaReadout(meter, now).historical;
  return {
    target: { ...target },
    title: `${PROVIDER_LABELS[target.provider]} ${account === undefined ? "quota" : `account ${account.label}`}`,
    activity:
      account?.active == null
        ? "Active account is not reported"
        : account.active
          ? "Selected in the source switcher; running agents may use other accounts."
          : "Not selected in the source switcher; running agents may still use this account.",
    measurement:
      age === null
        ? "No source measurement available."
        : `Last measured ${ageText} ago.${historical ? " Historical measurement." : ""}`,
    guidance:
      meter.issue === "auth_required"
        ? target.provider === "claude"
          ? "Renew this saved sign-in through cswap."
          : "This saved sign-in requires renewal in its source."
        : meter.issue === "rate_limited"
          ? "Collection is rate limited. Source retry and backoff control the next measurement."
          : meter.state === "unavailable"
            ? "Quota collection is unavailable."
            : null,
    windows: meter.windows.map((window) => ({
      tag: window.tag,
      percent: formatPercentRemaining(window.percentRemaining),
      reset: window.resetAtMs === null ? "reset unknown" : formatResetCountdown(window.resetAtMs, now),
    })),
  };
}

const textElement = (className: string, text: string): HTMLElement => {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = text;
  return element;
};

const detailsBody = (model: QuotaDetailsModel): HTMLElement => {
  const body = document.createElement("div");
  body.className = "quota-details-body";
  body.append(
    textElement("quota-detail-activity", model.activity),
    textElement("quota-detail-measurement", model.measurement),
  );
  if (model.guidance !== null) body.append(textElement("quota-detail-guidance", model.guidance));
  body.append(textElement("quota-detail-heading", "Last measured windows"));
  if (model.windows.length === 0) body.append(textElement("quota-detail-empty", "No windows reported."));
  for (const window of model.windows) {
    const row = document.createElement("div");
    row.className = "quota-detail-window";
    const readout = document.createElement("div");
    readout.className = "quota-detail-readout";
    readout.append(
      textElement("quota-detail-reset", window.reset),
      textElement("quota-detail-separator", "·"),
      textElement("quota-detail-percent", `${window.percent} remaining`),
    );
    row.append(textElement("quota-detail-tag", window.tag), readout);
    body.append(row);
  }
  return body;
};

export function buildQuotaDetailsOverlay(model: QuotaDetailsModel, onDismiss: () => void): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay quota-details-overlay";
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) {
      event.preventDefault(); // Preserve the focus restored by dismissal.
      onDismiss();
    }
  });
  const sheet = document.createElement("div");
  sheet.className = "action-sheet quota-details";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", model.title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "sheet-item quota-details-close";
  close.textContent = "Close";
  close.addEventListener("click", onDismiss);
  sheet.append(textElement("sheet-title", model.title), detailsBody(model), close);
  overlay.append(sheet);
  return overlay;
}

export type QuotaDetailsController = {
  isPressing: () => boolean;
  refresh: () => void;
  dismiss: () => void;
  dispose: () => void;
};

const sameTarget = (left: QuotaTarget | null, right: QuotaTarget | null): boolean =>
  left !== null && right !== null && left.provider === right.provider && left.accountId === right.accountId;

export function createQuotaDetailsController(options: {
  rail: HTMLElement;
  getPanels: () => readonly QuotaPanelModel[];
  now: () => number;
  beforeOpen: () => void;
  afterPress: () => void;
}): QuotaDetailsController {
  const { rail } = options;
  rail.tabIndex = -1;
  let openTarget: QuotaTarget | null = null;
  let overlay: HTMLElement | null = null;
  let signature = "";
  let disposed = false;
  let pressing = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let press: {
    target: QuotaTarget;
    pointerId: number;
    x: number;
    y: number;
    released: boolean;
    valid: boolean;
  } | null = null;

  const targetOf = (element: EventTarget | null): QuotaTarget | null => {
    if (!(element instanceof Element)) return null;
    const button = element.closest<HTMLElement>("button[data-quota-provider]");
    if (button === null || !rail.contains(button)) return null;
    const provider = button.dataset["quotaProvider"];
    if (!QUOTA_PROVIDER_KEYS.some((key) => key === provider)) return null;
    return { provider: provider as QuotaProviderKey, accountId: button.dataset["quotaAccount"] ?? null };
  };
  const resolve = (target: QuotaTarget): QuotaDetailsModel | null =>
    quotaDetailsModel(options.getPanels(), target, options.now());
  const focusClose = (): void => {
    overlay?.querySelector<HTMLButtonElement>(".quota-details-close")?.focus();
  };
  const restoreFocus = (target: QuotaTarget): void => {
    const button =
      resolve(target) === null
        ? undefined
        : [...rail.querySelectorAll<HTMLElement>("button[data-quota-provider]")].find((entry) =>
            sameTarget(targetOf(entry), target),
          );
    (button ?? rail).focus();
  };
  const dismiss = (): void => {
    const target = openTarget;
    openTarget = null;
    overlay?.remove();
    overlay = null;
    signature = "";
    if (target !== null) restoreFocus(target);
  };
  const refresh = (): void => {
    if (disposed || openTarget === null || overlay === null) return;
    const model = resolve(openTarget);
    if (model === null) {
      dismiss();
      return;
    }
    const next = JSON.stringify(model);
    if (next === signature) return;
    signature = next;
    const body = overlay.querySelector<HTMLElement>(".quota-details-body");
    const replacement = detailsBody(model);
    const scrollTop = body?.scrollTop ?? 0;
    body?.replaceWith(replacement);
    replacement.scrollTop = scrollTop;
    const title = overlay.querySelector<HTMLElement>(".sheet-title");
    if (title !== null) title.textContent = model.title;
    overlay.querySelector("[role=dialog]")?.setAttribute("aria-label", model.title);
    // Keep the close button mounted during updates, including an in-flight close tap.
  };
  const open = (target: QuotaTarget): void => {
    const model = resolve(target);
    if (disposed || model === null) return;
    options.beforeOpen();
    dismiss();
    openTarget = target;
    signature = JSON.stringify(model);
    overlay = buildQuotaDetailsOverlay(model, dismiss);
    document.body.append(overlay);
    focusClose();
  };
  const finishPress = (): void => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
    const wasPressing = pressing;
    pressing = false;
    if (wasPressing && !disposed) options.afterPress();
  };
  const cancelPress = (): void => {
    if (press !== null) {
      press.valid = false;
      press.released = true;
    }
    finishPress();
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (pressing) {
      cancelPress();
      return;
    }
    press = null;
    if (event.button !== 0 || !event.isPrimary) return;
    const target = targetOf(event.target);
    if (target === null || resolve(target) === null) return;
    press = { target, pointerId: event.pointerId, x: event.clientX, y: event.clientY, released: false, valid: true };
    pressing = true;
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (press === null || press.released || event.pointerId !== press.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) press.valid = false;
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (press === null || press.released || event.pointerId !== press.pointerId) return;
    onPointerMove(event);
    // Hit-test the release: touch's implicit pointer capture can still target the down button.
    press.valid =
      press.valid &&
      sameTarget(press.target, targetOf(document.elementFromPoint(event.clientX, event.clientY))) &&
      resolve(press.target) !== null;
    press.released = true;
    // Native click follows pointerup. Also settle strokes for which no click is emitted.
    // Keep the captured verdict for a delayed click, even after the rail can render again.
    settleTimer = setTimeout(finishPress, 0);
  };
  const onPointerCancel = (event: PointerEvent): void => {
    if (press?.pointerId === event.pointerId && !press.released) cancelPress();
  };
  const onClick = (event: MouseEvent): void => {
    const target = targetOf(event.target);
    if (target === null) return;
    event.preventDefault();
    const accepted =
      event.detail === 0 || (press?.released === true && press.valid && sameTarget(press.target, target));
    press = null;
    // Render the newest rail before opening so a removed target cannot reopen.
    finishPress();
    if (accepted) open(target);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (overlay === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
    } else if (event.key === "Tab") {
      event.preventDefault();
      focusClose();
    }
  };
  const onFocus = (event: FocusEvent): void => {
    if (overlay !== null && event.target instanceof Node && !overlay.contains(event.target)) focusClose();
  };

  rail.addEventListener("pointerdown", onPointerDown);
  rail.addEventListener("click", onClick);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  rail.addEventListener("lostpointercapture", onPointerCancel);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocus);
  window.addEventListener("blur", cancelPress);
  return {
    isPressing: () => pressing,
    refresh,
    dismiss,
    dispose: () => {
      disposed = true;
      cancelPress();
      press = null;
      dismiss();
      rail.removeEventListener("pointerdown", onPointerDown);
      rail.removeEventListener("click", onClick);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
      rail.removeEventListener("lostpointercapture", onPointerCancel);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("blur", cancelPress);
    },
  };
}

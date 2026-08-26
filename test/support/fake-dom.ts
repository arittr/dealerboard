export class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly listeners: Record<string, Array<() => void>> = {};
  className = "";
  textContent: string | null = null;
  type = "";

  readonly tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get classList(): { add: (...tokens: string[]) => void } {
    return {
      add: (...tokens) => {
        const names = new Set(this.className.split(/\s+/u).filter((name) => name.length > 0));
        for (const token of tokens) names.add(token);
        this.className = [...names].join(" ");
      },
    };
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners[type];
    if (listeners === undefined) {
      this.listeners[type] = [listener];
      return;
    }
    listeners.push(listener);
  }
}

export const descendants = (root: FakeElement): FakeElement[] => [root, ...root.children.flatMap(descendants)];

export const hasClass = (element: FakeElement, name: string): boolean => element.className.split(/\s+/u).includes(name);

export const renderedText = (root: FakeElement): string =>
  descendants(root)
    .map((element) => element.textContent ?? "")
    .join(" ");

export const withFakeDocument = <T>(run: (root: FakeElement) => T): T => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const documentValue = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createElementNS: (_namespace: string, tagName: string) => new FakeElement(tagName),
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentValue });
  try {
    return run(new FakeElement("root"));
  } finally {
    if (descriptor === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", descriptor);
  }
};

/**
 * JSON that keeps key order and the original text of every node. Writing emits untouched
 * nodes verbatim and re-renders only the objects on the path to a change, in the file's own
 * style (indent, `" : "` vs `": "`, Xcode's blank-line empty objects, trailing newline).
 */

export type JNode = JObject | JArray | JValue;

export interface JObject {
  kind: "object";
  entries: JEntry[];
  /** Original text; cleared when anything inside changes. */
  raw?: string;
}
export interface JEntry {
  key: string;
  rawKey?: string;
  value: JNode;
  /** Offset of the key in the original text. */
  offset?: number;
}
export interface JArray {
  kind: "array";
  items: JNode[];
  raw?: string;
}
export interface JValue {
  kind: "value";
  value: string | number | boolean | null;
  raw?: string;
}

export class JsonError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${line})`);
  }
}

export interface JsonStyle {
  indent: string;
  colon: string;
  /** Xcode writes `{}` as `{`, a blank line, then `}` at the parent's indent. */
  emptyObject: "blank-line" | "compact";
  trailingNewline: boolean;
}

export const XCODE_STYLE: JsonStyle = {
  indent: "  ",
  colon: " : ",
  emptyObject: "blank-line",
  trailingNewline: false,
};

export function detectStyle(text: string): JsonStyle {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? XCODE_STYLE.indent;
  return {
    indent,
    colon: /"\s:\s/.test(text) ? " : " : /":\s/.test(text) ? ": " : XCODE_STYLE.colon,
    emptyObject: /\{\s*\n\s*\n\s*\}/.test(text)
      ? "blank-line"
      : /\{\s*\}/.test(text)
        ? "compact"
        : XCODE_STYLE.emptyObject,
    trailingNewline: text.endsWith("\n"),
  };
}

export function parseJson(text: string): JNode {
  let i = 0;
  const line = (at: number) => text.slice(0, at).split("\n").length;
  const fail = (msg: string): never => {
    throw new JsonError(msg, line(i));
  };
  const ws = () => {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
  };
  const str = (): { value: string; raw: string } => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i >= text.length) fail("Unterminated string");
    i++;
    const raw = text.slice(start, i);
    try {
      return { value: JSON.parse(raw) as string, raw };
    } catch {
      return fail("Invalid string");
    }
  };
  const value = (): JNode => {
    ws();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i++;
      const entries: JEntry[] = [];
      ws();
      if (text[i] === "}") i++;
      else {
        for (;;) {
          ws();
          if (text[i] !== '"') fail("Expected a key");
          const offset = i;
          const k = str();
          ws();
          if (text[i] !== ":") fail('Expected ":"');
          i++;
          entries.push({ key: k.value, rawKey: k.raw, value: value(), offset });
          ws();
          if (text[i] === ",") {
            i++;
            continue;
          }
          if (text[i] === "}") {
            i++;
            break;
          }
          fail('Expected "," or "}"');
        }
      }
      return { kind: "object", entries, raw: text.slice(start, i) };
    }
    if (c === "[") {
      i++;
      const items: JNode[] = [];
      ws();
      if (text[i] === "]") i++;
      else {
        for (;;) {
          items.push(value());
          ws();
          if (text[i] === ",") {
            i++;
            continue;
          }
          if (text[i] === "]") {
            i++;
            break;
          }
          fail('Expected "," or "]"');
        }
      }
      return { kind: "array", items, raw: text.slice(start, i) };
    }
    if (c === '"') {
      const s = str();
      return { kind: "value", value: s.value, raw: s.raw };
    }
    const lit = /^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/.exec(text.slice(i, i + 40));
    if (!lit) return fail("Unexpected character");
    i += (lit[1] as string).length;
    const raw = lit[1] as string;
    return { kind: "value", value: JSON.parse(raw) as JValue["value"], raw };
  };
  const root = value();
  ws();
  if (i < text.length) fail("Unexpected text after the document");
  return root;
}

export function stringifyJson(node: JNode, style: JsonStyle): string {
  const out = write(node, 0, style);
  return style.trailingNewline ? `${out}\n` : out;
}

function write(node: JNode, depth: number, style: JsonStyle): string {
  if (node.raw !== undefined) return node.raw;
  const pad = (d: number) => style.indent.repeat(d);
  if (node.kind === "value") return JSON.stringify(node.value);
  if (node.kind === "array") {
    if (node.items.length === 0) return "[]";
    return `[\n${node.items.map((v) => pad(depth + 1) + write(v, depth + 1, style)).join(",\n")}\n${pad(depth)}]`;
  }
  if (node.entries.length === 0)
    return style.emptyObject === "blank-line" ? `{\n\n${pad(depth)}}` : "{}";
  const body = node.entries
    .map(
      (e) =>
        `${pad(depth + 1)}${e.rawKey ?? JSON.stringify(e.key)}${style.colon}${write(e.value, depth + 1, style)}`,
    )
    .join(",\n");
  return `{\n${body}\n${pad(depth)}}`;
}

/** Plain JS value of a node. */
export function toJs(node: JNode | undefined): unknown {
  if (!node) return undefined;
  if (node.kind === "value") return node.value;
  if (node.kind === "array") return node.items.map(toJs);
  return Object.fromEntries(node.entries.map((e) => [e.key, toJs(e.value)]));
}

/** A new node from a plain JS value, with object keys in `order`. */
export function fromJs(value: unknown, order: (a: string, b: string) => number): JNode {
  if (Array.isArray(value)) return { kind: "array", items: value.map((v) => fromJs(v, order)) };
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort(order);
    return {
      kind: "object",
      entries: keys.map((key) => ({
        key,
        value: fromJs((value as Record<string, unknown>)[key], order),
      })),
    };
  }
  return { kind: "value", value: value as JValue["value"] };
}

export function child(node: JNode | undefined, key: string): JNode | undefined {
  return node?.kind === "object" ? node.entries.find((e) => e.key === key)?.value : undefined;
}

/**
 * Sets `value` at `path`, creating objects on the way, and marks every object on the path as
 * changed. New keys go where `order` puts them among their siblings (under `parent`), so sorted
 * files stay sorted.
 */
export function setPath(
  root: JObject,
  path: string[],
  value: JNode,
  order: (a: string, b: string, parent: string[]) => number,
): void {
  let node: JObject = root;
  for (let d = 0; d < path.length; d++) {
    node.raw = undefined;
    const key = path[d] as string;
    const last = d === path.length - 1;
    let entry = node.entries.find((e) => e.key === key);
    if (!entry) {
      entry = { key, value: last ? value : { kind: "object", entries: [] } };
      const parent = path.slice(0, d);
      const at = node.entries.findIndex((e) => order(e.key, key, parent) > 0);
      if (at < 0) node.entries.push(entry);
      else node.entries.splice(at, 0, entry);
    } else if (last) {
      entry.value = value;
    }
    if (last) return;
    if (entry.value.kind !== "object") entry.value = { kind: "object", entries: [] };
    node = entry.value;
  }
}

/** Removes the value at `path`, marking every object on the way as changed. Returns false if absent. */
export function deletePath(root: JObject, path: string[]): boolean {
  const chain: JObject[] = [root];
  for (const key of path.slice(0, -1)) {
    const next = child(chain.at(-1), key);
    if (next?.kind !== "object") return false;
    chain.push(next);
  }
  const parent = chain.at(-1) as JObject;
  const at = parent.entries.findIndex((e) => e.key === path.at(-1));
  if (at < 0) return false;
  parent.entries.splice(at, 1);
  for (const node of chain) node.raw = undefined;
  return true;
}

/** Line number (1-based) of an offset in `text`. */
export function lineIndex(text: string): (offset?: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset = 0) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

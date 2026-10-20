import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { UserError } from "../core/errors.js";
import type { FileSystem } from "../core/fs.js";
import { openProject } from "../core/project.js";
import { ENTRY_STATES, type EntryState } from "../core/status.js";
import { buildUsageIndex, type UsageIndex } from "../core/usage.js";
import {
  type ApproveResult,
  approve,
  languageName,
  MessageValueSchema,
  nextBatch,
  removeTranslations,
  submit,
} from "../core/workflow.js";
import { REVIEW_PAGE } from "./page.js";

export interface ReviewOptions {
  fs: FileSystem;
  cwd: string;
  config?: string;
  /** Locales to show (default: all configured). */
  locales?: string[];
  /** States ticked when the page opens (default: draft, edited, untracked). */
  states?: EntryState[];
  /** 0 picks a free port. */
  port?: number;
}

export interface ReviewServer {
  url: string;
  close(): Promise<void>;
}

/** What a reviewer can look at: everything with a translation on disk. */
const SHOWN: EntryState[] = ENTRY_STATES.filter((s) => s !== "missing");
const DEFAULT_STATES: EntryState[] = ["draft", "edited", "untracked"];
/** States a reviewer's approval may accept. Stale entries need translating again first. */
const APPROVABLE: EntryState[] = ["draft", "reviewed", "edited", "untracked"];
const RTL = new Set([
  "ar",
  "arc",
  "ckb",
  "dv",
  "fa",
  "he",
  "iw",
  "ks",
  "ps",
  "sd",
  "ug",
  "ur",
  "yi",
]);

const At = z.object({ target: z.string(), locale: z.string(), key: z.string() });
const SaveBody = At.extend({ value: MessageValueSchema });
const ApproveBody = z.object({
  items: z.array(At).min(1),
  to: z.enum(["reviewed", "approved"]).optional(),
});

/**
 * A review page for people, served on localhost. Every action goes through the same
 * submit/approve/remove the CLI uses, so checks and the lockfile behave exactly the same.
 * A random token in the URL keeps other local processes out.
 */
export async function startReview(opts: ReviewOptions): Promise<ReviewServer> {
  const project = () => openProject(opts.fs, { cwd: opts.cwd, config: opts.config });
  // Fail now, not on the first page load, when there's no config.
  const first = await project();
  let usages: Promise<UsageIndex> | undefined;
  const usageIndex = () => (usages ??= buildUsageIndex(first));
  const token = randomBytes(16).toString("hex");

  const routes: Record<string, (body: unknown) => Promise<unknown>> = {
    "GET /api/items": async () => {
      const p = await project();
      const batch = await nextBatch(p, {
        locales: opts.locales,
        states: SHOWN,
        limit: Number.MAX_SAFE_INTEGER,
        usages: await usageIndex(),
      });
      const locales = opts.locales ?? Object.keys(batch.locales);
      return {
        items: batch.items,
        states: SHOWN,
        selected: opts.states ?? DEFAULT_STATES,
        locales: Object.fromEntries(
          locales.map((l) => [
            l,
            {
              language: languageName(l),
              rtl: RTL.has(l.split(/[-_]/)[0]?.toLowerCase() ?? ""),
            },
          ]),
        ),
      };
    },
    // A person typed this, so it may replace hand edits and approved translations.
    "POST /api/save": async (body) => {
      const s = SaveBody.parse(body);
      return submit(await project(), [s], { force: true, usages: await usageIndex() });
    },
    // One string or everything the page shows: approved per target and locale, by key.
    "POST /api/approve": async (body) => {
      const a = ApproveBody.parse(body);
      const groups = new Map<string, { target: string; locale: string; keys: string[] }>();
      for (const it of a.items) {
        const id = `${it.target}\u0000${it.locale}`;
        const group = groups.get(id) ?? { target: it.target, locale: it.locale, keys: [] };
        group.keys.push(it.key);
        groups.set(id, group);
      }
      const changed: ApproveResult["changed"] = [];
      for (const g of groups.values()) {
        const result = await approve(await project(), {
          targets: [g.target],
          locales: [g.locale],
          keys: g.keys,
          states: APPROVABLE,
          to: a.to ?? "approved",
        });
        changed.push(...result.changed);
      }
      return { changed };
    },
    "POST /api/reject": async (body) => {
      const a = At.parse(body);
      return removeTranslations(await project(), {
        targets: [a.target],
        locales: [a.locale],
        keys: [a.key],
      });
    },
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const known = e instanceof UserError || e instanceof z.ZodError || e instanceof SyntaxError;
      send(res, known ? 400 : 500, { error: known ? e.message : String(e) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!sameToken(url.searchParams.get("t") ?? "", token)) {
      send(res, 403, { error: "Open the link localship printed; it carries the access token." });
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end(REVIEW_PAGE);
      return;
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) {
      send(res, 404, { error: "Not found" });
      return;
    }
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : undefined;
    send(res, 200, await route(body));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Best effort: the link is printed too, for when no browser opens. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    // The printed link still works.
  }
}

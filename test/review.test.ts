import { afterEach, describe, expect, it } from "vitest";
import { memoryFs } from "../src/core/fs.js";
import { openProject } from "../src/core/project.js";
import { computeStatus } from "../src/core/status.js";
import { submit } from "../src/core/workflow.js";
import { type ReviewServer, startReview } from "../src/review/server.js";

const STRINGS = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="save">Save</string>
    <string name="welcome">Welcome, %1$s!</string>
    <plurals name="days_left">
        <item quantity="one">%d day left</item>
        <item quantity="other">%d days left</item>
    </plurals>
</resources>
`;

async function setup() {
  const fs = memoryFs({
    "/p/localship.yaml": [
      "locales: [ar]",
      "targets:",
      "  - format: android-xml",
      "    path: res",
    ].join("\n"),
    "/p/res/values/strings.xml": STRINGS,
  });
  const project = await openProject(fs, { cwd: "/p" });
  await submit(project, [
    { locale: "ar", key: "save", value: "حفظ" },
    { locale: "ar", key: "welcome", value: "مرحبًا، %1$s!" },
  ]);
  return fs;
}

let review: ReviewServer | undefined;
afterEach(async () => {
  await review?.close();
  review = undefined;
});

const call = (path: string, body?: unknown) => {
  const url = new URL(review?.url ?? "");
  url.pathname = path;
  return fetch(url, body ? { method: "POST", body: JSON.stringify(body) } : {});
};
// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions.
const json = (path: string, body?: unknown): Promise<any> => call(path, body).then((r) => r.json());
const at = { target: "android", locale: "ar", key: "save" };

describe("review server", () => {
  it("needs the token", async () => {
    review = await startReview({ fs: await setup(), cwd: "/p" });
    const url = new URL(review.url);
    url.search = "";
    expect((await fetch(url)).status).toBe(403);
    url.search = "?t=wrong";
    expect((await fetch(url)).status).toBe(403);
    const page = await fetch(review.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Localship Review");
  });

  it("lists translations to review, marking right-to-left languages", async () => {
    review = await startReview({ fs: await setup(), cwd: "/p" });
    const data = await json("/api/items");
    expect(data.locales.ar).toEqual({ language: "Arabic", rtl: true });
    expect(data.selected).toEqual(["draft", "edited", "untracked"]);
    expect(data.states).not.toContain("missing");
    expect(data.items.map((i: { key: string; state: string }) => [i.key, i.state])).toEqual([
      ["save", "draft"],
      ["welcome", "draft"],
    ]);
  });

  it("saves edits through the checks, approves and rejects", async () => {
    const fs = await setup();
    review = await startReview({ fs, cwd: "/p" });

    const broken = await json("/api/save", {
      target: "android",
      locale: "ar",
      key: "welcome",
      value: "مرحبًا",
    });
    expect(broken.rejected[0].errors[0].code).toMatch(/placeholder/);

    const saved = await json("/api/save", { ...at, value: "احفظ" });
    expect(saved.accepted).toHaveLength(1);
    expect(await fs.readFile("/p/res/values-ar/strings.xml")).toContain("احفظ");

    const approved = await json("/api/approve", { items: [at] });
    expect(approved.changed).toHaveLength(1);

    // Approved work is a person's; the page can't throw it away.
    const kept = await json("/api/reject", at);
    expect(kept.refused[0].state).toBe("approved");

    const rejected = await json("/api/reject", { target: "android", locale: "ar", key: "welcome" });
    expect(rejected.removed).toHaveLength(1);

    const status = computeStatus(await openProject(fs, { cwd: "/p" }));
    expect(JSON.stringify(status)).toContain("approved");
  });

  it("approves many at once, leaving out what can't be approved", async () => {
    const fs = await setup();
    review = await startReview({ fs, cwd: "/p" });
    const welcome = { ...at, key: "welcome" };
    const approved = await json("/api/approve", {
      items: [at, welcome, { ...at, key: "days_left" }],
    });
    expect(approved.changed.map((c: { key: string }) => c.key)).toEqual(["save", "welcome"]);
    const states = (await json("/api/items")).items.map((i: { state: string }) => i.state);
    expect(states).toEqual(["approved", "approved"]);
    expect((await call("/api/approve", { items: [] })).status).toBe(400);
  });

  it("answers bad requests with a reason", async () => {
    review = await startReview({ fs: await setup(), cwd: "/p" });
    const res = await call("/api/save", { locale: "ar" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBeTruthy();
    expect((await call("/api/nope")).status).toBe(404);
  });
});

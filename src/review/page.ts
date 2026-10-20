/**
 * The review page: one self-contained HTML file, no build step or CDN. It talks to
 * the review server's /api routes, passing on the token from its own URL.
 */
export const REVIEW_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Localship Review</title>
<style>
:root {
  --bg: #f7f7f5; --card: #fff; --text: #1d1d1f; --muted: #6e6e73; --line: #e3e3e0;
  --accent: #2f6fde; --ok: #1f8a4c; --warn: #b26a00; --bad: #c62f2f; --chip: #efefec;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161617; --card: #1f1f21; --text: #ececee; --muted: #9a9aa0; --line: #333336;
    --accent: #6b9bff; --ok: #4cc27f; --warn: #e0a040; --bad: #ff6b6b; --chip: #2a2a2d;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--line);
  padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
h1 { font-size: 16px; margin: 0 8px 0 0; }
select, input[type=search] { font: inherit; color: inherit; background: var(--card);
  border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; }
input[type=search] { flex: 1 1 200px; min-width: 0; }
header select { max-width: 100%; }
.states { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--muted); }
.states label { white-space: nowrap; cursor: pointer; }
.count { color: var(--muted); margin-left: auto; }
main { max-width: 960px; margin: 0 auto; padding: 16px; display: grid; gap: 12px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
.top { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 10px; }
.key { font: 600 13px ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.tag { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--chip); color: var(--muted); }
.st-draft { color: var(--accent); } .st-approved, .st-reviewed { color: var(--ok); }
.st-stale, .st-edited, .st-untracked { color: var(--warn); }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.cols > * { min-width: 0; }
@media (max-width: 640px) { .cols { grid-template-columns: 1fr; } .count { margin-left: 0; } }
.label { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.source { white-space: pre-wrap; overflow-wrap: anywhere; padding: 8px; border-radius: 8px; background: var(--chip); }
.form { margin-bottom: 6px; }
.form .label { margin: 0 0 2px; }
textarea { width: 100%; font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line);
  border-radius: 8px; padding: 8px; resize: vertical; min-height: 38px; field-sizing: content; }
textarea:focus, select:focus, input:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.meta { margin-top: 10px; display: grid; gap: 4px; color: var(--muted); font-size: 13px; }
.meta code, pre { font: 12px ui-monospace, Menlo, Consolas, monospace; }
pre { margin: 2px 0 0; padding: 6px 8px; background: var(--chip); border-radius: 6px; overflow-x: auto; white-space: pre; }
.actions { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
button { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--text);
  border-radius: 8px; padding: 6px 12px; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: .5; cursor: default; }
.msg { font-size: 13px; } .msg.ok { color: var(--ok); } .msg.bad { color: var(--bad); white-space: pre-wrap; }
.warn { color: var(--warn); }
.empty { text-align: center; color: var(--muted); padding: 48px 0; }
</style>
</head>
<body>
<header>
  <h1>Localship Review</h1>
  <select id="locale" aria-label="Language"></select>
  <input id="q" type="search" placeholder="Search keys and text" aria-label="Search">
  <div class="states" id="states"></div>
  <span class="count" id="count"></span>
  <button id="approveAll" class="primary" disabled>Approve all</button>
  <span class="msg" id="allMsg"></span>
</header>
<main id="list"><p class="empty">Loading…</p></main>
<script>
const token = new URLSearchParams(location.search).get("t") || "";
const api = (path, body) =>
  fetch(path + "?t=" + encodeURIComponent(token), body ? {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  } : {}).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  });

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
};
const APPROVABLE = ["draft", "reviewed", "edited", "untracked"];
let visible = [];
// Cards with unsaved changes, so Approve all can't approve text other than what's on screen.
const edits = new Set();
const SHORT = ["button", "tab", "chip", "title", "menu item"];
let data = { items: [], locales: {}, states: [], selected: [] };
const filters = { locale: "", states: new Set(), q: "" };

async function load() {
  data = await api("/api/items");
  if (!filters.states.size) data.selected.forEach((s) => filters.states.add(s));
  const locales = Object.keys(data.locales);
  if (!filters.locale || !locales.includes(filters.locale)) filters.locale = locales[0] || "";
  $("locale").replaceChildren(...locales.map((l) =>
    el("option", { value: l, selected: l === filters.locale, textContent: data.locales[l].language + " (" + l + ")" })));
  $("states").replaceChildren(...data.states.map((s) => {
    const n = data.items.filter((i) => i.locale === filters.locale && i.state === s).length;
    const box = el("input", { type: "checkbox", checked: filters.states.has(s) });
    box.onchange = () => { box.checked ? filters.states.add(s) : filters.states.delete(s); render(); };
    return el("label", {}, box, " " + s + " " + n);
  }));
  render();
}

const text = (v) => typeof v === "string" ? v : Array.isArray(v) ? v.join("\\n") : Object.values(v).join("\\n");

function render() {
  const q = filters.q.toLowerCase();
  const shown = data.items.filter((i) =>
    i.locale === filters.locale && filters.states.has(i.state) &&
    (!q || (i.key + "\\n" + text(i.source) + "\\n" + text(i.current || "")).toLowerCase().includes(q)));
  $("count").textContent = shown.length + " of " + data.items.filter((i) => i.locale === filters.locale).length;
  visible = shown.filter((i) => APPROVABLE.includes(i.state));
  $("approveAll").textContent = "Approve all (" + visible.length + ")";
  $("approveAll").disabled = !visible.length;
  edits.clear();
  $("list").replaceChildren(...(shown.length ? shown.map(card)
    : [el("p", { className: "empty", textContent: "Nothing to review here. Try other states or another language." })]));
}

function fields(item, dir) {
  const cur = item.current ?? "";
  const area = (value, label) => {
    const t = el("textarea", { value, dir, lang: item.locale, rows: 1 });
    t.setAttribute("aria-label", label);
    return t;
  };
  if (item.kind === "plural" && typeof cur === "object" && !Array.isArray(cur)) {
    const forms = item.pluralForms?.length ? item.pluralForms.map((f) => f.form) : Object.keys(cur);
    const examples = Object.fromEntries((item.pluralForms || []).map((f) => [f.form, f.examples]));
    return forms.map((f) => ({ name: f, input: area(cur[f] ?? "", f),
      label: f + (examples[f] ? " · " + examples[f] : "") }));
  }
  if (Array.isArray(cur)) return cur.map((v, n) => ({ name: n, input: area(v, "item " + (n + 1)), label: "item " + (n + 1) }));
  return [{ name: null, input: area(String(cur), "translation") }];
}

function readValue(item, inputs) {
  if (inputs.length === 1 && inputs[0].name === null) return inputs[0].input.value;
  if (typeof inputs[0].name === "number") return inputs.map((f) => f.input.value);
  return Object.fromEntries(inputs.filter((f) => f.input.value !== "").map((f) => [f.name, f.input.value]));
}

function card(item) {
  const dir = data.locales[item.locale]?.rtl ? "rtl" : "ltr";
  const inputs = fields(item, dir);
  const msg = el("span", { className: "msg" });
  const show = (ok, t) => { msg.className = "msg " + (ok ? "ok" : "bad"); msg.textContent = t; };
  const original = JSON.stringify(readValue(item, inputs));
  const save = el("button", { className: "primary", textContent: "Save", disabled: true });
  const tag = el("span", { className: "tag st-" + item.state, textContent: item.state });
  const refresh = async () => {
    const next = await reload().catch(() => undefined);
    const now = next?.find((i) => i.target === item.target && i.locale === item.locale && i.key === item.key);
    tag.className = "tag st-" + (now?.state || "missing");
    tag.textContent = now?.state || "missing";
  };
  const dirty = () => {
    save.disabled = JSON.stringify(readValue(item, inputs)) === original;
    save.disabled ? edits.delete(item) : edits.add(item);
  };
  inputs.forEach((f) => f.input.addEventListener("input", dirty));

  const act = async (path, body, done) => {
    try { done(await api(path, { target: item.target, locale: item.locale, key: item.key, ...body })); }
    catch (e) { show(false, e.message); }
  };
  save.onclick = () => act("/api/save", { value: readValue(item, inputs) }, (r) => {
    if (r.rejected.length) return show(false, r.rejected[0].errors.map((e) => e.message).join("\\n"));
    edits.delete(item);
    const warns = r.accepted[0]?.warnings || [];
    show(!warns.length, warns.length ? "Saved with warnings: " + warns.map((w) => w.message).join("; ") : "Saved as draft");
    refresh();
  });
  const approveBtn = (to, label) => {
    const b = el("button", { textContent: label });
    b.onclick = () => act("/api/approve", { to, items: [{ target: item.target, locale: item.locale, key: item.key }] }, (r) =>
      r.changed.length ? (show(true, label === "Approve" ? "Approved" : "Marked reviewed"), refresh())
        : show(false, "Nothing changed. Save your edits first."));
    return b;
  };
  const reject = el("button", { textContent: "Reject" });
  reject.onclick = () => act("/api/reject", {}, (r) =>
    r.removed.length ? (show(true, "Rejected; it will be translated again"), refresh())
      : show(false, "Kept: this is " + (r.refused[0]?.state || "not a draft") + ". Only drafts can be rejected here."));

  const canApprove = APPROVABLE.includes(item.state);
  const tooLong = SHORT.includes(item.role) && text(item.current || "").length > text(item.source).length * 1.5 + 4;
  const meta = [
    item.comment && el("div", {}, "Comment: " + item.comment),
    item.context && el("div", {}, "Context: " + item.context),
    item.note && el("div", {}, "Translator's note: " + item.note),
    item.editedByHand && el("div", { className: "warn" }, "Edited by hand after it was translated"),
    tooLong && el("div", { className: "warn" }, "Much longer than the source, and it's a " + item.role + ". Check it fits."),
    item.placeholders?.length && el("div", {}, "Keep: ", ...item.placeholders.map((p) => el("code", { textContent: p + " " }))),
    item.glossary?.length && el("div", {}, "Glossary: " + item.glossary.map((g) =>
      g.term + (g.keep ? " (keep as is)" : g.use ? " → " + g.use : "") + (g.note ? " — " + g.note : "")).join("; ")),
    item.memory?.length && el("div", {}, "Elsewhere: " + item.memory.map((m) => text(m.value) + " (" + m.from + ")").join("; ")),
    ...(item.usage || []).map((u) => el("div", {}, "Used at " + u.at, el("pre", { textContent: u.code }))),
    item.references?.length && el("div", {}, "Used at " + item.references.join(", ")),
  ];
  const sourceText = item.kind === "plural" && typeof item.source === "object" && !Array.isArray(item.source)
    ? Object.entries(item.source).map(([f, v]) => f + ": " + v).join("\\n") : text(item.source);

  return el("article", { className: "card" },
    el("div", { className: "top" },
      el("span", { className: "key", textContent: item.key }),
      tag,
      item.role && el("span", { className: "tag", textContent: item.role }),
      el("span", { className: "tag", textContent: item.target })),
    el("div", { className: "cols" },
      el("div", {},
        el("div", { className: "label", textContent: "Source" }),
        el("div", { className: "source", textContent: sourceText }),
        item.previousSource && el("div", { className: "meta warn" }, "Was: " + text(item.previousSource))),
      el("div", {},
        el("div", { className: "label", textContent: data.locales[item.locale]?.language || item.locale }),
        ...inputs.map((f) => f.label ? el("div", { className: "form" }, el("div", { className: "label", textContent: f.label }), f.input) : f.input))),
    el("div", { className: "meta" }, ...meta),
    el("div", { className: "actions" }, save,
      canApprove && approveBtn("approved", "Approve"),
      canApprove && item.state !== "reviewed" && approveBtn("reviewed", "Mark reviewed"),
      ["draft", "stale"].includes(item.state) && reject, msg));
}

// Fresh data without re-rendering, so a row doesn't vanish under the cursor after an action.
async function reload() {
  data = { ...data, ...(await api("/api/items")) };
  return data.items;
}

$("approveAll").onclick = async () => {
  const msg = $("allMsg");
  if (edits.size) {
    msg.className = "msg bad";
    msg.textContent = "Save or undo your edits first";
    return;
  }
  const language = data.locales[filters.locale]?.language || filters.locale;
  if (!confirm("Approve " + visible.length + " " + language + " translations shown on this page?")) return;
  try {
    const r = await api("/api/approve", { items: visible.map(({ target, locale, key }) => ({ target, locale, key })) });
    msg.className = "msg ok";
    msg.textContent = "Approved " + r.changed.length;
    await load();
  } catch (e) {
    msg.className = "msg bad";
    msg.textContent = e.message;
  }
};
$("locale").onchange = (e) => { filters.locale = e.target.value; load(); };
$("q").oninput = (e) => { filters.q = e.target.value; render(); };
load().catch((e) => $("list").replaceChildren(el("p", { className: "empty", textContent: e.message })));
</script>
</body>
</html>
`;

/**
 * Offline self-test for dsh-windows-caption-safe.
 *
 * Runs the SHIPPED lib/client.js against a minimal fake DOM: enough surface for
 * the engine (createElement, querySelectorAll, MutationObserver, rAF,
 * getComputedStyle, windowControlsOverlay) and nothing more. No browser, no
 * jsdom, no network.
 *
 * Usage: node self-test.mjs [path-to-client.js]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: the workspace path contains a space.
const CLIENT = process.argv[2] ?? fileURLToPath(new URL("./lib/client.js", import.meta.url));

//#region minimal DOM

/** camelCase -> kebab-case, so style.paddingTop and style['padding-top'] agree. */
const toKebab = (prop) => String(prop).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Style object supporting both camelCase props and setProperty/getPropertyValue. */
function makeStyle() {
  const store = new Map();
  const base = {
    setProperty: (k, v) => void store.set(toKebab(k), String(v)),
    getPropertyValue: (k) => store.get(toKebab(k)) ?? "",
    removeProperty: (k) => void store.delete(toKebab(k)),
  };
  return new Proxy(base, {
    get: (t, prop) => {
      if (typeof prop === "symbol") return undefined;
      if (prop in t) return t[prop];
      return store.get(toKebab(prop)) ?? "";
    },
    set: (t, prop, value) => {
      if (typeof prop === "symbol") return true;
      if (prop in t) return true;
      store.set(toKebab(prop), String(value));
      return true;
    },
  });
}

const CLASS_RE = /\.([\w-]+)/g;
const ATTR_RE = /\[([\w-]+)(?:="([^"]*)")?\]/g;

/** Match one compound selector part (tag + .class + [attr] + [attr="v"]). */
function matchesPart(el, part) {
  const tagMatch = /^([a-zA-Z*]+)/.exec(part);
  if (tagMatch !== null && tagMatch[1] !== "*" && el.tagName !== tagMatch[1].toUpperCase()) return false;
  const body = part.slice(tagMatch === null ? 0 : tagMatch[1].length);
  for (const m of body.matchAll(CLASS_RE)) {
    const classes = String(el.attrs.class ?? "").split(/\s+/);
    if (!classes.includes(m[1])) return false;
  }
  for (const m of body.matchAll(ATTR_RE)) {
    if (!Object.hasOwn(el.attrs, m[1])) return false;
    if (m[2] !== undefined && el.attrs[m[1]] !== m[2]) return false;
  }
  return true;
}

/** Support a descendant chain of compound selectors ("a b") and comma lists. */
function matches(el, selector) {
  return selector
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .some((one) => {
      const parts = one.split(/\s+/).filter((p) => p !== "");
      if (!matchesPart(el, parts[parts.length - 1])) return false;
      let node = el.parent;
      for (let i = parts.length - 2; i >= 0; i -= 1) {
        let found = false;
        while (node !== null) {
          if (matchesPart(node, parts[i])) { found = true; node = node.parent; break; }
          node = node.parent;
        }
        if (!found) return false;
      }
      return true;
    });
}

function descendants(root, out = []) {
  for (const child of root.children) { out.push(child); descendants(child, out); }
  return out;
}

function makeEl(tagName, attrs = {}) {
  const el = {
    tagName: String(tagName).toUpperCase(),
    attrs: { ...attrs },
    children: [],
    parent: null,
    style: makeStyle(),
    dataset: {},
    textContent: "",
    isConnected: true,
    getAttribute(n) { return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null; },
    hasAttribute(n) { return Object.hasOwn(this.attrs, n); },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    removeAttribute(n) { delete this.attrs[n]; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    remove() {
      if (this.parent === null) return;
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
      this.isConnected = false;
    },
    matches(sel) { return matches(this, sel); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; },
    querySelectorAll(sel) { return descendants(this).filter((n) => matches(n, sel)); },
    addEventListener() {},
    removeEventListener() {},
  };
  return el;
}

/** MutationObserver stub: records instances so the test can flush them. */
const observers = [];
class FakeMutationObserver {
  constructor(callback) { this.callback = callback; this.disconnected = false; this.target = null; observers.push(this); }
  observe(target) { this.target = target; }
  disconnect() { this.disconnected = true; }
  takeRecords() { return []; }
  flush() { if (!this.disconnected) this.callback([]); }
}

/** Flush only the observers watching a given node, as a real DOM would. */
const flushObserversOf = (target) => {
  for (const o of observers) if (o.target === target) o.flush();
};

/** Flush every live observer, then drain the rAF queue: "let the engine settle". */
const settle = () => {
  for (const o of observers) o.flush();
  flushRaf();
};

/** rAF stub with an explicit queue, so passes are deterministic. */
const rafQueue = [];
const flushRaf = () => { const q = rafQueue.splice(0); for (const fn of q) fn(); };

const computed = new Map();
const doc = {
  head: null,
  body: null,
  documentElement: null,
  createElement: (tag) => makeEl(tag),
  querySelector(sel) { return doc.documentElement.querySelector(sel); },
  querySelectorAll(sel) { return doc.documentElement.querySelectorAll(sel); },
  addEventListener() {},
  removeEventListener() {},
};

const win = {
  navigator: {},
  document: doc,
  getComputedStyle: (el) => ({
    getPropertyValue: (name) => (el === doc.documentElement ? computed.get(name) ?? "" : ""),
  }),
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
  cancelAnimationFrame: () => {},
  addEventListener() {},
  removeEventListener() {},
};

globalThis.window = win;
globalThis.document = doc;
globalThis.MutationObserver = FakeMutationObserver;
globalThis.requestAnimationFrame = win.requestAnimationFrame;

//#endregion

//#region load the shipped module

let exported = null;
let registeredId = null;
win.__ModuleLoader__ = {
  load: ({ id, factory }) => {
    registeredId = id;
    exported = factory(() => { throw new Error("client.js must not require() anything"); });
  },
};

doc.documentElement = makeEl("html");
doc.head = makeEl("head");
doc.body = makeEl("body");
doc.documentElement.appendChild(doc.head);
doc.documentElement.appendChild(doc.body);

new Function("window", "document", "MutationObserver", readFileSync(CLIENT, "utf8"))(win, doc, FakeMutationObserver);
if (exported === null) throw new Error("module did not register");
const T = exported.__test;

// Metadata identity is load-bearing: Cordis keys the client entry on
// exports.name, and the Loader row must name the same package. Compare against
// the real package.json / cordis.patch.yml rather than literals, so a rename can
// never drift out of sync.
const pkgPath = CLIENT.replace(/lib[\\/]client\.js$/, "package.json");
const rowPath = CLIENT.replace(/lib[\\/]client\.js$/, "cordis.patch.yml");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const rowText = readFileSync(rowPath, "utf8");

//#endregion

//#region assertions

let failures = 0;
const check = (label, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

console.log("--- package / entry identity ---");
check("exports.name matches the package name", exported.name, pkg.name);
check("module id matches the package name", registeredId, pkg.name);
check("cordis.patch.yml row names the same package", rowText.includes(`name: '${pkg.name}'`), true);
check("keeps the sibling plugin inject convention", Array.isArray(exported.inject) && exported.inject.join(","), "slots");
check("package.json exports ./client", pkg.exports["./client"], "./lib/client.js");
check("package.json files ships the engine", pkg.files.includes("lib"), true);

console.log("\n--- parsePositivePx ---");
check("plain px", T.parsePositivePx("40px"), 40);
check("float px", T.parsePositivePx(" 36.5px "), 36.5);
check("bare number", T.parsePositivePx("40"), 40);
check("empty", T.parsePositivePx(""), 0);
check("non-numeric", T.parsePositivePx("auto"), 0);
check("zero is inert", T.parsePositivePx("0px"), 0);
check("negative is inert", T.parsePositivePx("-8px"), 0);
check("undefined", T.parsePositivePx(undefined), 0);

console.log("\n--- resolveSafeTop ---");
const setVars = (map) => { computed.clear(); for (const [k, v] of Object.entries(map)) computed.set(k, v); };
const setWco = (wco) => { win.navigator.windowControlsOverlay = wco; };
const setFullscreen = (on) => { if (on) doc.documentElement.setAttribute("data-fullscreen", "true"); else doc.documentElement.removeAttribute("data-fullscreen"); };

setWco(undefined);
setFullscreen(false);
setVars({ "--dsh-frame-top-clearance": "40px", "--dsh-windows-titlebar-height": "40px" });
check("host variable fallback (no WCO)", T.resolveSafeTop(win, doc.documentElement), 40);

setVars({ "--dsh-windows-titlebar-height": "36px" });
check("legacy variable when clearance absent", T.resolveSafeTop(win, doc.documentElement), 36);

setVars({});
check("no host variable -> inert", T.resolveSafeTop(win, doc.documentElement), 0);

setVars({ "--dsh-frame-top-clearance": "40px" });
setWco({ visible: true, getTitlebarAreaRect: () => ({ x: 0, y: 0, width: 1200, height: 36 }), addEventListener() {}, removeEventListener() {} });
check("WCO geometry outranks host variables", T.resolveSafeTop(win, doc.documentElement), 36);

setWco({ visible: false, getTitlebarAreaRect: () => ({ height: 36 }) });
check("ghost WCO (visible:false) ignored -> host fallback", T.resolveSafeTop(win, doc.documentElement), 40);

setWco({ visible: true, getTitlebarAreaRect() { throw new Error("boom"); } });
check("throwing WCO ignored -> host fallback", T.resolveSafeTop(win, doc.documentElement), 40);

setWco({ visible: true, getTitlebarAreaRect: () => ({ height: 0 }) });
check("zero-height WCO ignored -> host fallback", T.resolveSafeTop(win, doc.documentElement), 40);

setWco({ visible: true, getTitlebarAreaRect: () => ({ height: 36 }) });
setFullscreen(true);
check("fullscreen forces inert", T.resolveSafeTop(win, doc.documentElement), 0);
setFullscreen(false);
check("leaving fullscreen restores", T.resolveSafeTop(win, doc.documentElement), 36);

console.log("\n--- shellHasCaption ---");
setWco(undefined);
check("no marker, no WCO -> false", T.shellHasCaption(win, doc.documentElement), false);
doc.documentElement.setAttribute("data-windows-titlebar", "");
check("host marker -> true", T.shellHasCaption(win, doc.documentElement), true);
doc.documentElement.removeAttribute("data-windows-titlebar");
setWco({ visible: true, getTitlebarAreaRect: () => ({ height: 36 }) });
check("visible WCO alone -> true", T.shellHasCaption(win, doc.documentElement), true);

console.log("\n--- isPreviewDialog ---");
const mk = (tag, attrs) => makeEl(tag, attrs);
const preview = mk("div", { role: "dialog", "aria-modal": "true" });
preview.appendChild(mk("img", {}));
preview.appendChild(mk("button", { "aria-label": "close" }));
check("image preview recognized", T.isPreviewDialog(preview), true);
const quota = mk("div", { role: "alertdialog", "aria-modal": "true" });
quota.appendChild(mk("button", { "aria-label": "x" }));
check("alertdialog rejected", T.isPreviewDialog(quota), false);
const noImg = mk("div", { role: "dialog", "aria-modal": "true" });
noImg.appendChild(mk("button", { "aria-label": "x" }));
check("dialog without img rejected", T.isPreviewDialog(noImg), false);
const noBtn = mk("div", { role: "dialog", "aria-modal": "true" });
noBtn.appendChild(mk("img", {}));
check("dialog without labelled button rejected", T.isPreviewDialog(noBtn), false);

console.log("\n--- patchLightbox / restoreLightbox ---");
T.patchLightbox(preview, 40);
check("backdrop padded by inset", preview.style.paddingTop, "40px");
check("backdrop box-sizing set", preview.style.boxSizing, "border-box");
check("close button clears caption", preview.querySelector("button").style.top, "60px");
check("close button keeps right gutter", preview.querySelector("button").style.right, "20px");
check("patch marker set", preview.hasAttribute(T.PATCHED_ATTR), true);
T.restoreLightbox(preview);
check("restore clears padding", preview.style.paddingTop, "");
check("restore clears button top", preview.querySelector("button").style.top, "");
check("restore clears marker", preview.hasAttribute(T.PATCHED_ATTR), false);

console.log("\n--- engine lifecycle (real apply()) ---");
computed.clear();
computed.set("--dsh-frame-top-clearance", "40px");
doc.documentElement.removeAttribute("data-windows-titlebar");
setWco(undefined);
setFullscreen(false);

let cleanup = null;
const ctx = { effect: (fn) => { cleanup = fn(); } };
exported.apply(ctx);

check("inert before the shell marker appears", doc.documentElement.hasAttribute(T.SAFE_ATTR), false);
check("no stylesheet injected while inert", doc.head.querySelectorAll(`style[${"data-plugin"}="${pkg.name}"]`).length, 0);

// The shell publishes its marker late (preload runs after plugin activation).
doc.documentElement.setAttribute("data-windows-titlebar", "");
settle();

check("marker arrival starts the engine", doc.documentElement.hasAttribute(T.SAFE_ATTR), true);
check("inset published as a CSS variable", doc.documentElement.style.getPropertyValue(T.CSS_VAR), "40px");
check("stylesheet now present", doc.head.querySelectorAll(`style[${"data-plugin"}="${pkg.name}"]`).length >= 1, true);

console.log("\n--- built-in rule: univer CSS contract (runtime-injected) ---");
// Assert against the RUNTIME-INJECTED stylesheet, not the raw source text: the
// source stores template placeholders (${INLINE_TOP_VAR}), so text matching
// would only prove the placeholder exists, not what it resolves to.
const injected = doc.head
  .querySelectorAll(`style[data-plugin="${pkg.name}"]`)
  .map((s) => s.textContent ?? "")
  .join("\n");
for (const [label, needle] of [
  ["floating window top adds the inset to its own offset", `top:calc(var(${T.INLINE_TOP_VAR},12px) + var(${T.CSS_VAR},0px)) !important`],
  ["floating window scoped off when maximized", ".uvf_win:not(.uvf_win_max)"],
  ["maximized window inset", `inset:calc(12px + var(${T.CSS_VAR},0px))`],
  ["fullscreen review panel inset", `inset:calc(10px + var(${T.CSS_VAR},0px))`],
]) {
  check(label, injected.includes(needle), true);
}
check(
  "lightbox rule leaks no document-wide dialog selector",
  injected.includes('[role="dialog"][aria-modal="true"]{'),
  false,
);
const raw = readFileSync(CLIENT, "utf8");
check("opt-in utilities ship a translate form", raw.includes("html[data-caption-safe] [data-caption-safe-shift]"), true);
check("opt-in utilities ship a padding form", raw.includes("html[data-caption-safe] [data-caption-safe-inset]"), true);

console.log("\n--- runtime API for other plugins ---");
const api = win.__dshCaptionSafe;
check("global contract exposed", typeof api, "object");
check("api reports the inset", api.safeTop, 40);
check("api reports active", api.active, true);
check("api names the CSS variable", api.cssVar, T.CSS_VAR);
check("built-in rules registered", api.rules().sort().join(","), "image-lightbox,univer-floating-window");

console.log("\n--- the layout's stylesheet lands late (head is observed) ---");
// Simulate the host injecting its own <style> into <head> AFTER activation: the
// clearance is not readable yet (computed is still empty), so the engine must be
// woken by the head observer rather than staying permanently inert.
computed.clear();
settle();
check("no inset while the layout stylesheet is missing", doc.documentElement.style.getPropertyValue(T.CSS_VAR), "0px");
check("engine went inert meanwhile", doc.documentElement.hasAttribute(T.SAFE_ATTR), false);
// Now the layout's stylesheet arrives and the variable becomes readable.
computed.set("--dsh-frame-top-clearance", "40px");
doc.head.appendChild(makeEl("style", {}));
flushObserversOf(doc.head);
flushRaf();
check("late stylesheet re-arms the engine", doc.documentElement.hasAttribute(T.SAFE_ATTR), true);
check("late stylesheet republishes the inset", doc.documentElement.style.getPropertyValue(T.CSS_VAR), "40px");

console.log("\n--- rule 1 end-to-end: the engine patches a live preview ---");
// `preview` was only unit-tested above while detached. Attach it so the built-in
// rule is exercised through the real engine, then let fullscreen tear it down.
doc.body.appendChild(preview);
settle();
check("engine patched the live preview", preview.hasAttribute(T.PATCHED_ATTR), true);
check("engine gave it the caption padding", preview.style.paddingTop, "40px");

let seen = null;
const off = api.subscribe((v) => { seen = v; });
check("subscribe fires immediately", seen, 40);
off();
let after = null;
api.subscribe((v) => { after = v; })();
check("unsubscribe stops notifications", seen, 40);

const ruleEl = makeEl("div", { class: "my-panel" });
doc.body.appendChild(ruleEl);
let synced = 0;
const offRule = api.registerRule({
  id: "test:panel",
  css: "html[data-caption-safe] .my-panel{top:var(--dsh-caption-safe-top,0px)}",
  sync: () => { synced += 1; ruleEl.setAttribute("data-synced", ""); },
  restore: () => { ruleEl.removeAttribute("data-synced"); },
});
flushRaf();
check("registered rule was applied", ruleEl.hasAttribute("data-synced"), true);
check("registered rule appears in the list", api.rules().includes("test:panel"), true);
offRule();
check("unregistering removes the rule", api.rules().includes("test:panel"), false);
check("unregistering drops its stylesheet", doc.head.querySelectorAll('style[data-caption-rule="test:panel"]').length, 0);

check("bad registerRule input rejected", (() => { try { api.registerRule({}); return "no-throw"; } catch { return "threw"; } })(), "threw");

console.log("\n--- univer rule mirrors inline top ---");
const uwin = makeEl("section", { class: "uvf_win" });
uwin.style.top = "36px";
doc.body.appendChild(uwin);
settle();
check("inline top mirrored into the calc variable", uwin.style.getPropertyValue(T.INLINE_TOP_VAR), "36px");

const uwinBare = makeEl("section", { class: "uvf_win" });
doc.body.appendChild(uwinBare);
settle();
check("absent inline top leaves no override", uwinBare.style.getPropertyValue(T.INLINE_TOP_VAR), "");

console.log("\n--- fullscreen tears the inset back down ---");
setFullscreen(true);
settle();
check("fullscreen clears the marker", doc.documentElement.hasAttribute(T.SAFE_ATTR), false);
check("fullscreen zeroes the variable", doc.documentElement.style.getPropertyValue(T.CSS_VAR), "0px");
check("fullscreen leaves NO stylesheet behind", doc.head.querySelectorAll(`style[${"data-plugin"}="${pkg.name}"]`).length, 0);
check("fullscreen restores the lightbox patch", preview.hasAttribute(T.PATCHED_ATTR), false);
check("fullscreen clears mirrored inline top", uwin.style.getPropertyValue(T.INLINE_TOP_VAR), "");
setFullscreen(false);
settle();
check("leaving fullscreen re-arms", doc.documentElement.hasAttribute(T.SAFE_ATTR), true);

console.log("\n--- unload restores the document ---");
if (cleanup !== null) cleanup();
check("unload removes the CSS variable", doc.documentElement.style.getPropertyValue(T.CSS_VAR), "");
check("unload removes the marker", doc.documentElement.hasAttribute(T.SAFE_ATTR), false);
check("unload removes every stylesheet", doc.head.querySelectorAll(`style[${"data-plugin"}="${pkg.name}"]`).length, 0);
check("unload removes the global", win.__dshCaptionSafe, undefined);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

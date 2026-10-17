/**
 * dsh-windows-caption-safe — Client half.
 *
 * A generic Windows caption safe-area engine for DSH client plugins.
 *
 * ## The problem it generalises
 *
 * DSH's desktop shell draws the native window controls (minimize / maximize /
 * close) in an Electron `titleBarOverlay` strip — a NATIVE layer above the Web
 * contents. No `z-index` can cover it. The host publishes the reserved height as
 * CSS custom properties on <html> (owned by @deepseek-ai/dsh-client-ui-layout):
 *
 *   html[data-windows-titlebar]{
 *     --dsh-windows-titlebar-height: 40px;   // injected by the shell preload
 *     --dsh-frame-top-clearance:     40px;
 *     --dsh-frame-chrome-top:        40px;
 *     --dsh-frame-overlay-top:       60px;   // clearance + 20px
 *   }
 *
 * Host surfaces honour it (`AppFrame` pads by it, the settings overlay and the
 * right sidebar track it). Third-party surfaces regularly do not, because the
 * contract is published as CSS variables only — there is no JS entry point, and
 * a floating window positioned from JS (`el.style.top = y`) cannot read it
 * without knowing the variable names. Two observed cases:
 *
 *   - `ImageLightbox` hardcodes `position: fixed; top: 20px; right: 20px`.
 *   - `dsh-univer-office` floating windows start at a fixed `VIEWPORT_GUTTER`
 *     of 12px and clamp `y` to >= 12, so they always sit under the buttons.
 *
 * ## What this plugin does
 *
 * 1. Resolves the real safe-area height and publishes it as ONE contract:
 *      - CSS:  `var(--dsh-caption-safe-top)` on <html>
 *      - JS:   `window.__dshCaptionSafe.safeTop` / `subscribe()` / `registerRule()`
 *      - marker: `html[data-caption-safe]` exists only while the inset is > 0
 *    Resolution prefers the standard Window Controls Overlay geometry (so the
 *    value follows the real overlay and maximize/restore), falls back to the
 *    host's own variables, and is 0 in fullscreen or on any other shell.
 *
 * 2. Applies declarative RULES to surfaces that cannot express the fix in plain
 *    CSS (inline styles, unknown per-instance offsets). A rule is a small object
 *    with `id`, optional `css`, and `sync` / `restore` hooks.
 *
 * 3. Ships a CSS opt-in for surfaces that CAN: add `data-caption-safe-shift`
 *    (translate down) or `data-caption-safe-inset` (padding-top) to a node and it
 *    avoids the strip with no JS of its own.
 *
 * Everything is inert when the resolved inset is 0: no stylesheet is injected and
 * no rule writes to the document.
 *
 * ## Built-in rules
 *
 *   - `image-lightbox`       — the original fix (kept as rule #1).
 *   - `univer-floating-window` — dsh-univer-office worktree windows.
 *
 * ## Adding another surface
 *
 * Append a rule to `BUILTIN_RULES`, or register one at runtime from any other
 * client plugin:
 *
 *   const off = window.__dshCaptionSafe.registerRule({
 *     id: "my-plugin:panel",
 *     css: "html[data-caption-safe] .my-panel{top:calc(8px + var(--dsh-caption-safe-top,0px)) !important}",
 *     sync: (ctx) => { for (const el of ctx.doc.querySelectorAll(".my-panel")) el.dataset.captionSafe = ""; },
 *     restore: (ctx) => { for (const el of ctx.doc.querySelectorAll("[data-caption-safe]")) delete el.dataset.captionSafe; },
 *   });
 */
window.__ModuleLoader__.load({
  id: "dsh-windows-caption-safe",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** Marker attribute so a reload can find and reuse injected styles. */
    const STYLE_ATTR = "data-plugin";
    const STYLE_ID = "dsh-windows-caption-safe";

    /** The published contract. */
    const CSS_VAR = "--dsh-caption-safe-top";
    const SAFE_ATTR = "data-caption-safe";
    const GLOBAL_KEY = "__dshCaptionSafe";

    /** Opt-in utilities any surface may use without registering a rule. */
    const UTILITY_CSS = `
/* dsh-windows-caption-safe: opt-in utilities, inert unless the inset is > 0. */
html[data-caption-safe] [data-caption-safe-shift]{translate:0 var(${CSS_VAR},0px)}
html[data-caption-safe] [data-caption-safe-inset]{padding-top:var(${CSS_VAR},0px);box-sizing:border-box}
`;

    /** Attribute set on every dialog this plugin has already adjusted. */
    const PATCHED_ATTR = "data-wlf-patched";

    /**
     * Custom property a rule mirrors a surface's own inline `top` into, so the
     * stylesheet can add the inset without knowing the per-instance offset.
     */
    const INLINE_TOP_VAR = "--caption-inline-top";

    /** Fallback gutter for surfaces whose inline offset is absent. */
    const DEFAULT_GUTTER = 12;

    //#region safe-area resolution

    /**
     * Parse a CSS length such as `"40px"` into a positive number of pixels.
     * @param value - raw custom-property or inline-style value.
     * @returns the pixel count, or 0 when absent, non-numeric, or not positive.
     */
    function parsePositivePx(value) {
      if (typeof value !== "string") return 0;
      const parsed = Number.parseFloat(value.trim());
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }

    /**
     * Whether the standard Window Controls Overlay reports a real title bar.
     *
     * Headless and non-overlay shells expose the API as a ghost (the object
     * exists but `visible` is false), so `visible === true` is required before
     * the geometry is trusted — otherwise the plugin would invent an inset on
     * platforms that have none.
     * @param win - the browser window.
     * @returns true when WCO is present and genuinely visible.
     */
    function wcoVisible(win) {
      const wco = win.navigator === undefined ? undefined : win.navigator.windowControlsOverlay;
      if (wco === undefined || wco === null) return false;
      return wco.visible === true && typeof wco.getTitlebarAreaRect === "function";
    }

    /**
     * The title-bar height reported by the Window Controls Overlay.
     * @param win - the browser window.
     * @returns the height in whole pixels, or 0 when unavailable.
     */
    function wcoSafeTop(win) {
      if (!wcoVisible(win)) return 0;
      let rect;
      try {
        rect = win.navigator.windowControlsOverlay.getTitlebarAreaRect();
      } catch {
        return 0;
      }
      if (rect === null || rect === undefined) return 0;
      const height = Number(rect.height);
      return Number.isFinite(height) && height > 0 ? Math.round(height) : 0;
    }

    /**
     * The inset the host itself publishes for overlay/chrome positioning.
     *
     * `--dsh-frame-top-clearance` is the full reserved strip; the older
     * `--dsh-windows-titlebar-height` is the fallback name. Both are read only
     * as a fallback for shells without WCO geometry.
     * @param win - the browser window.
     * @param root - the document element.
     * @returns the inset in whole pixels, or 0 when the host publishes none.
     */
    function hostCssSafeTop(win, root) {
      if (typeof win.getComputedStyle !== "function") return 0;
      const style = win.getComputedStyle(root);
      const clearance = parsePositivePx(style.getPropertyValue("--dsh-frame-top-clearance"));
      if (clearance > 0) return Math.round(clearance);
      return Math.round(parsePositivePx(style.getPropertyValue("--dsh-windows-titlebar-height")));
    }

    /**
     * Resolve the caption strip height that surface content must clear.
     *
     * Resolution order: fullscreen (0) → WCO real geometry → host variables.
     * In fullscreen the native controls are gone, so any published clearance
     * would over-inset the content.
     * @param win - the browser window.
     * @param root - the document element.
     * @returns the inset in whole pixels; 0 means "stay inert".
     */
    function resolveSafeTop(win, root) {
      if (root.hasAttribute("data-fullscreen")) return 0;
      const wco = wcoSafeTop(win);
      if (wco > 0) return wco;
      return hostCssSafeTop(win, root);
    }

    /**
     * Whether this shell has a caption strip at all. Used only to decide whether
     * installing the observers is worthwhile; the value itself still comes from
     * {@link resolveSafeTop} on every pass.
     * @param win - the browser window.
     * @param root - the document element.
     * @returns true when the shell may reserve a caption strip.
     */
    function shellHasCaption(win, root) {
      return root.hasAttribute("data-windows-titlebar") || wcoVisible(win);
    }

    //#endregion

    //#region rule 1 — image lightbox

    /**
     * The preview overlay: a body-portaled dialog holding an image and its
     * close control. Requiring all three landmarks keeps this off every other
     * dialog the app renders (settings surfaces, quota dialog, approvals).
     * @param node - candidate element.
     * @returns true when the node is the image preview dialog.
     */
    function isPreviewDialog(node) {
      if (node === null || node.getAttribute("role") !== "dialog") return false;
      if (node.getAttribute("aria-modal") !== "true") return false;
      if (node.querySelector("img") === null) return false;
      return node.querySelector("button[aria-label]") !== null;
    }

    /**
     * Realign the preview with the caption safe area. Written as inline styles,
     * because the lightbox's own class names are build-time hashes and its rules
     * are `position: fixed` at a hardcoded 20px. The patch disappears with the
     * overlay instead of leaking into the document.
     * @param dialog - the preview overlay.
     * @param safeTop - the resolved inset in pixels.
     */
    function patchLightbox(dialog, safeTop) {
      const button = dialog.querySelector("button[aria-label]");
      if (button === null) return;
      // Backdrop: keep the dimming mask below the caption so the native window
      // controls stay visible and the window stays draggable.
      dialog.style.paddingTop = `${safeTop}px`;
      dialog.style.boxSizing = "border-box";
      // Close control: sit just under the caption instead of on top of it.
      button.style.position = "fixed";
      button.style.top = `${safeTop + 20}px`;
      button.style.right = "20px";
      button.style.zIndex = "1";
      dialog.setAttribute(PATCHED_ATTR, "");
    }

    /**
     * Undo {@link patchLightbox}, so a fullscreen transition (inset → 0) leaves
     * no stale inline geometry behind.
     * @param dialog - the preview overlay.
     */
    function restoreLightbox(dialog) {
      if (!dialog.hasAttribute(PATCHED_ATTR)) return;
      dialog.style.removeProperty("padding-top");
      dialog.style.removeProperty("box-sizing");
      const button = dialog.querySelector("button[aria-label]");
      if (button !== null) {
        for (const property of ["position", "top", "right", "z-index"]) {
          button.style.removeProperty(property);
        }
      }
      dialog.removeAttribute(PATCHED_ATTR);
    }

    /** Rule 1: the original image-preview fix, generalised onto the engine. */
    const lightboxRule = {
      id: "image-lightbox",
      sync(ctx) {
        const dialogs = ctx.doc.querySelectorAll('[role="dialog"][aria-modal="true"]');
        for (const dialog of dialogs) {
          if (!isPreviewDialog(dialog)) continue;
          patchLightbox(dialog, ctx.safeTop);
        }
      },
      restore(ctx) {
        const dialogs = ctx.doc.querySelectorAll(`[${PATCHED_ATTR}]`);
        for (const dialog of dialogs) restoreLightbox(dialog);
      },
    };

    //#endregion

    //#region rule 2 — dsh-univer-office floating windows

    /**
     * dsh-univer-office positions its floating worktree windows from JS:
     * `initialRect` starts at `VIEWPORT_GUTTER = 12` and `fitRect` clamps `y` to
     * >= 12, so the window title bar always sits under the native buttons. Its
     * class names (`uvf_*`) are stable, not build hashes, so the fix is CSS.
     *
     * `top` is an inline style, so the stylesheet adds the inset to a value the
     * rule mirrors into `--caption-inline-top` rather than guessing the cascade
     * offset (`12 + stackIndex * 24`). Maximize and the fullscreen review panel
     * use `inset` overrides, which are exact and cannot clip off-screen.
     */
    const univerRule = {
      id: "univer-floating-window",
      css: `
/* dsh-windows-caption-safe: dsh-univer-office floating windows. */
html[data-caption-safe] .uvf_win:not(.uvf_win_max){
  top:calc(var(${INLINE_TOP_VAR},${DEFAULT_GUTTER}px) + var(${CSS_VAR},0px)) !important;
  max-height:calc(100vh - var(${INLINE_TOP_VAR},${DEFAULT_GUTTER}px) - var(${CSS_VAR},0px) - ${DEFAULT_GUTTER}px) !important;
}
html[data-caption-safe] .uvf_win_max{
  inset:calc(12px + var(${CSS_VAR},0px)) 12px 12px 12px !important;
}
html[data-caption-safe] .uvf_panel_fullscreen{
  inset:calc(10px + var(${CSS_VAR},0px)) 10px 10px 10px !important;
}
`,
      sync(ctx) {
        const windows = ctx.doc.querySelectorAll(".uvf_win");
        for (const win of windows) {
          // Mirror the surface's own inline offset; the stylesheet adds the inset.
          const raw = win.style.top;
          const top = raw === "" ? Number.NaN : Number.parseFloat(raw);
          if (Number.isFinite(top)) win.style.setProperty(INLINE_TOP_VAR, `${top}px`);
          else win.style.removeProperty(INLINE_TOP_VAR);
        }
      },
      restore(ctx) {
        const windows = ctx.doc.querySelectorAll(".uvf_win");
        for (const win of windows) win.style.removeProperty(INLINE_TOP_VAR);
      },
    };

    //#endregion

    /**
     * The rule set, in evaluation order. Append an entry here to align another
     * surface permanently, or register one at runtime through
     * `window.__dshCaptionSafe.registerRule`.
     */
    const BUILTIN_RULES = [lightboxRule, univerRule];

    /**
     * Plugin body.
     * @param ctx - the client Cordis context.
     */
    function apply(ctx) {
      if (typeof document === "undefined") return;
      const doc = document;
      const win = window;
      const root = doc.documentElement;
      if (root === null) return;

      const rules = new Map();
      for (const rule of BUILTIN_RULES) rules.set(rule.id, rule);

      const subscribers = new Set();
      /** Last resolved inset; -1 forces the first publish to count as a change. */
      let safeTop = -1;
      /** Per-rule stylesheet, so an unregistered rule can take its CSS with it. */
      const ruleStyles = new Map();
      let frame = null;
      let started = false;
      let disposed = false;
      const teardown = [];

      const report = (rule, error) => {
        console.warn(`[dsh-windows-caption-safe] rule "${rule.id}" failed`, error);
      };

      /** Inject (or reuse) one rule's stylesheet. */
      const ensureRuleStyle = (rule) => {
        if (typeof rule.css !== "string" || rule.css === "") return;
        const existing = ruleStyles.get(rule.id);
        if (existing !== undefined && existing.isConnected) return;
        const tag = doc.createElement("style");
        tag.setAttribute(STYLE_ATTR, STYLE_ID);
        tag.setAttribute("data-caption-rule", rule.id);
        tag.textContent = rule.css;
        doc.head.appendChild(tag);
        ruleStyles.set(rule.id, tag);
      };

      /** Drop every stylesheet this plugin injected. */
      const removeStyles = () => {
        for (const tag of doc.querySelectorAll(`style[${STYLE_ATTR}="${STYLE_ID}"]`)) tag.remove();
        ruleStyles.clear();
      };

      const context = () => ({
        safeTop: Math.max(0, safeTop),
        active: safeTop > 0,
        doc,
        win,
        root,
        cssVar: CSS_VAR,
        markerAttr: SAFE_ATTR,
        inlineTopVar: INLINE_TOP_VAR,
      });

      /** One full pass: resolve, publish, then let every rule converge. */
      const run = () => {
        frame = null;
        if (disposed) return;
        const next = resolveSafeTop(win, root);
        const changed = next !== safeTop;
        safeTop = next;
        root.style.setProperty(CSS_VAR, `${safeTop}px`);
        if (safeTop > 0) {
          root.setAttribute(SAFE_ATTR, "");
          ensureRuleStyle({ id: "core-utilities", css: UTILITY_CSS });
        } else {
          root.removeAttribute(SAFE_ATTR);
        }
        const shared = context();
        for (const rule of rules.values()) {
          if (rule.enabled === false) continue;
          try {
            if (safeTop > 0) {
              ensureRuleStyle(rule);
              if (typeof rule.sync === "function") rule.sync(shared);
            } else if (typeof rule.restore === "function") {
              rule.restore(shared);
            }
          } catch (error) {
            report(rule, error);
          }
        }
        if (changed) {
          removeStylesIfInactive();
          for (const notify of [...subscribers]) {
            try {
              notify(Math.max(0, safeTop));
            } catch (error) {
              console.warn("[dsh-windows-caption-safe] subscriber failed", error);
            }
          }
        }
      };

      /** Inactive passes must leave no stylesheet behind: every rule is gated. */
      const removeStylesIfInactive = () => {
        if (safeTop > 0) return;
        removeStyles();
      };

      /** Coalesce bursts (drag emits a style mutation per frame) into one pass. */
      const schedule = () => {
        if (frame !== null || disposed) return;
        frame = win.requestAnimationFrame(run);
      };

      /** Start observing once the shell is known to reserve a caption strip. */
      const start = () => {
        if (started || disposed) return;
        started = true;
        run();
        const bodyObserver = new MutationObserver(schedule);
        bodyObserver.observe(doc.body ?? root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["style", "class"],
        });
        teardown.push(() => bodyObserver.disconnect());
        // The layout publishes --dsh-frame-top-clearance from a <style> it
        // injects into <head>, which can land after this module activates
        // (`immediately: true`). Watch head too, or a late stylesheet would
        // leave the engine inert. Self-insertions cannot loop: ensureRuleStyle
        // reuses its tag, and removeStyles only fires while tags still exist.
        const headObserver = new MutationObserver(schedule);
        headObserver.observe(doc.head, { childList: true });
        teardown.push(() => headObserver.disconnect());
        const onResize = () => schedule();
        win.addEventListener("resize", onResize);
        teardown.push(() => win.removeEventListener("resize", onResize));
        // Follow the real overlay geometry across maximize/restore.
        const wco = win.navigator === undefined ? undefined : win.navigator.windowControlsOverlay;
        if (wco !== undefined && wco !== null && typeof wco.addEventListener === "function") {
          wco.addEventListener("geometrychange", onResize);
          teardown.push(() => wco.removeEventListener("geometrychange", onResize));
        }
        // Fullscreen toggling changes the effective inset (and re-reads the host vars).
        const rootObserver = new MutationObserver(schedule);
        rootObserver.observe(root, { attributes: true, attributeFilter: ["data-fullscreen", "data-windows-titlebar", "style"] });
        teardown.push(() => rootObserver.disconnect());
      };

      ctx.effect(() => {
        // The shell marker and the layout's custom properties can both land after
        // this module activates (`immediately: true`), so wait for the marker
        // rather than sampling once.
        if (shellHasCaption(win, root)) {
          start();
        } else {
          const waiter = new MutationObserver(() => {
            if (!shellHasCaption(win, root)) return;
            waiter.disconnect();
            start();
          });
          waiter.observe(root, { attributes: true, attributeFilter: ["data-windows-titlebar"] });
          const onResize = () => {
            if (!shellHasCaption(win, root)) return;
            waiter.disconnect();
            win.removeEventListener("resize", onResize);
            start();
          };
          win.addEventListener("resize", onResize);
          teardown.push(() => {
            waiter.disconnect();
            win.removeEventListener("resize", onResize);
          });
        }

        // Generic runtime contract for any other client plugin.
        const api = {
          version: 2,
          get safeTop() {
            return Math.max(0, safeTop);
          },
          get active() {
            return safeTop > 0;
          },
          get cssVar() {
            return CSS_VAR;
          },
          rules() {
            return [...rules.keys()];
          },
          subscribe(notify) {
            if (typeof notify !== "function") throw new TypeError("subscribe expects a function");
            subscribers.add(notify);
            notify(Math.max(0, safeTop));
            return () => subscribers.delete(notify);
          },
          registerRule(rule) {
            if (rule === null || typeof rule !== "object" || typeof rule.id !== "string" || rule.id === "") {
              throw new TypeError("registerRule expects an object with a non-empty string id");
            }
            rules.set(rule.id, rule);
            schedule();
            return () => {
              rules.delete(rule.id);
              const tag = ruleStyles.get(rule.id);
              if (tag !== undefined) {
                tag.remove();
                ruleStyles.delete(rule.id);
              }
            };
          },
        };
        win[GLOBAL_KEY] = api;

        return () => {
          disposed = true;
          if (frame !== null) win.cancelAnimationFrame(frame);
          for (const dispose of teardown.splice(0)) {
            try {
              dispose();
            } catch {
              // Teardown must never mask the unload.
            }
          }
          // Leave the document as we found it.
          root.style.removeProperty(CSS_VAR);
          root.removeAttribute(SAFE_ATTR);
          for (const rule of rules.values()) {
            if (typeof rule.restore !== "function") continue;
            try {
              rule.restore(context());
            } catch {
              // Ignore: the overlay may already be gone.
            }
          }
          removeStyles();
          subscribers.clear();
          if (win[GLOBAL_KEY] === api) delete win[GLOBAL_KEY];
        };
      }, "windows-caption-safe: engine");
    }

    exports.apply = apply;
    /**
     * Kept as `["slots"]` to match the previously working configuration and
     * every sibling client plugin. The engine reads no client service (it only
     * reads the host's own CSS variables), so this declaration is inert; it is
     * deliberately NOT used to gate on anything.
     */
    exports.inject = ["slots"];
    /**
     * Must stay identical to the package name and to the Loader row's `name`:
     * Cordis keys the client entry on it, so a mismatch would misname the entry.
     * The engine's own identity (log prefix, CSS marker, global) is internal and
     * deliberately descriptive — see STYLE_ID / GLOBAL_KEY.
     */
    exports.name = "dsh-windows-caption-safe";

    /**
     * Pure helpers, exposed for the offline self-test. Not part of the runtime
     * API surface: only the engine and `window.__dshCaptionSafe` are.
     */
    exports.__test = {
      parsePositivePx,
      wcoVisible,
      wcoSafeTop,
      hostCssSafeTop,
      resolveSafeTop,
      shellHasCaption,
      isPreviewDialog,
      patchLightbox,
      restoreLightbox,
      PATCHED_ATTR,
      INLINE_TOP_VAR,
      CSS_VAR,
      SAFE_ATTR,
    };
    return module.exports;
  },
});

/**
 * Independent check that the injected CSS produces the RIGHT geometry.
 *
 * The self-test proves the strings are what we wrote; this proves the arithmetic
 * is what we want, by evaluating the `calc()` expressions the stylesheet emits
 * against the real host values (inset 40px, dsh-univer-office's own offsets).
 *
 * Every expression is modelled as a pure function of BOTH the surface's own
 * offset and the resolved inset, so the "inset 0 => untouched" case is provable
 * rather than asserted with a baked-in constant.
 */

const SAFE = 40;   // host caption strip (--dsh-frame-top-clearance)
const GUTTER = 12; // dsh-univer-office VIEWPORT_GUTTER

/** `top:calc(var(--caption-inline-top,12px) + var(--dsh-caption-safe-top,0px))` */
const floatingTop = (inlineTop, safe) => (inlineTop ?? GUTTER) + safe;

/** `inset:calc(12px + var(--dsh-caption-safe-top,0px)) 12px 12px 12px` */
const maximizedInset = (safe) => ({ top: 12 + safe, right: 12, bottom: 12, left: 12 });

/** `inset:calc(10px + var(--dsh-caption-safe-top,0px)) 10px 10px 10px` */
const fullscreenInset = (safe) => ({ top: 10 + safe, right: 10, bottom: 10, left: 10 });

/** Lightbox close button: `top: safeTop + 20px; right: 20px`. */
const closeButtonTop = (safe) => safe + 20;

/** `max-height:calc(100vh - inline - safe - 12px)`, at a 900px viewport. */
const maxHeight = (inlineTop, safe, viewport = 900) => viewport - (inlineTop ?? GUTTER) - safe - GUTTER;

let failures = 0;
const check = (label, actual, expected) => {
  const ok = typeof expected === "string" || typeof actual === "string"
    ? Object.is(actual, expected)
    : Math.abs(actual - expected) < 1e-9;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

console.log("--- the reported bug ---");
check("observed position is 12px, under a 0..40px strip", 12 < SAFE, true);
check("with the fix, stack 0 lands below the strip", floatingTop(12, SAFE) >= SAFE, true);
check("stack 0 exact position", floatingTop(12, SAFE), 52);
check("clearance below the buttons", floatingTop(12, SAFE) - SAFE, 12);

console.log("\n--- cascade stacks (12 + n*24) ---");
check("stack 1 exact position", floatingTop(12 + 24, SAFE), 76);
check("stack 2 exact position", floatingTop(12 + 48, SAFE), 100);
for (const n of [0, 1, 2, 3, 4]) {
  check(`stack ${n} clears the strip`, floatingTop(12 + n * 24, SAFE) >= SAFE, true);
}

console.log("\n--- user-dragged windows keep their offset ---");
check("dragged to y=900 stays at 900 + inset", floatingTop(900, SAFE) - SAFE, 900);
check("a dragged window is not snapped back", floatingTop(900, SAFE) !== 52, true);

console.log("\n--- maximize / fullscreen review panel ---");
const max = maximizedInset(SAFE);
check("maximized clears the strip", max.top >= SAFE, true);
check("maximized top", max.top, 52);
check("maximized keeps 12px gutters elsewhere", `${max.right},${max.bottom},${max.left}`, "12,12,12");
const full = fullscreenInset(SAFE);
check("fullscreen panel clears the strip", full.top >= SAFE, true);
check("fullscreen panel top", full.top, 50);
check("fullscreen keeps 10px gutters elsewhere", `${full.right},${full.bottom},${full.left}`, "10,10,10");

console.log("\n--- floating window cannot be clipped by the max-height guard ---");
check("max-height stays positive for a low window", maxHeight(12, SAFE) > 0, true);
check("max-height leaves room", maxHeight(12, SAFE), 900 - 12 - SAFE - 12);
check("max-height stays positive for a dragged-down window", maxHeight(700, SAFE) > 0, true);
check("max-height still positive when inset is 0", maxHeight(12, 0) > 0, true);

console.log("\n--- lightbox close button ---");
check("close button clears the strip", closeButtonTop(SAFE) >= SAFE, true);
check("close button position (inset + its own 20px gutter)", closeButtonTop(SAFE), 60);

console.log("\n--- inset 0 (fullscreen / non-Windows) must be a true no-op ---");
check("floating window untouched", floatingTop(12, 0), 12);
check("floating window max-height untouched", maxHeight(12, 0), 900 - 12 - 12);
check("maximized untouched", maximizedInset(0).top, 12);
check("fullscreen panel untouched", fullscreenInset(0).top, 10);
check("close button untouched at its original 20px", closeButtonTop(0), 20);

console.log("\n--- other real inset heights the host has used ---");
for (const inset of [32, 36, 40]) {
  check(`inset ${inset}px clears a ${inset}px strip`, floatingTop(12, inset) >= inset, true);
  check(`inset ${inset}px keeps the 12px visual gap`, floatingTop(12, inset) - inset, 12);
}

console.log(failures === 0 ? "\nAll geometry checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * End-to-end check: is the RUNNING host serving the new engine?
 *
 * Reads one frame from the client-modules SSE channel (/plugins/events), finds
 * this plugin's revision, then fetches the advertised bundle URL and asserts the
 * new engine marker is inside it. Proves the change reached the live server
 * without restarting DSH.
 *
 * The graph's `url` is a document-relative combo reference with no leading
 * slash (`plugins/??<id>/client.js&rev=...`), so it is joined to the base with
 * an added separator rather than treated as an absolute path.
 */
import { statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const BASE = (process.env.DSH_WEB_URL ?? "http://127.0.0.1:19387").replace(/\/+$/, "");

// Derive the identity from this package's own manifest, so a rename can never
// leave the check asserting on a stale name.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(`${HERE}package.json`, "utf8"));
const ID = pkg.name;
/** The engine's internal marker (log/CSS identity), not the package name. */
const MARKER = "dsh-windows-caption-safe";
const CLIENT_PATH = process.argv[2]
  ?? `${HERE}lib/client.js`;

/** Mirrors client-modules' artifactRevision: sha1 over framed mtime/ctime/size. */
const framedHash = (domain, parts) => {
  const hash = createHash("sha1").update(domain).update("\0");
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
  return hash.digest("hex").slice(0, 12);
};
const artifactRevision = (s) => framedHash("plugin-artifact", [
  String(s.mtimeMs), String(s.ctimeMs), String(s.size),
]);

const withTimeout = async (url, ms, read) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await read(await fetch(url, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
};

// 1. One SSE frame carries the whole graph, including each row's rev + url.
let graph = null;
try {
  await withTimeout(`${BASE}/plugins/events`, 4000, async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (graph === null) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const frame = JSON.parse(line.slice(5));
        if (frame.type === "graph") { graph = frame.graph; break; }
      }
    }
    reader.cancel().catch(() => {});
  });
} catch (error) {
  console.log(`SSE channel unreachable: ${error.message}`);
}

if (graph === null) {
  console.log("RESULT: could not read the client-modules graph (is the GUI open?)");
  process.exit(2);
}

const row = (graph.entries ?? []).find((entry) => entry.id === ID);
if (row === undefined) {
  console.log(`RESULT: ${ID} is not in the client graph`);
  process.exit(1);
}
console.log(`graph row: id=${row.id} rev=${row.rev}`);
console.log(`bundle url: ${row.url}`);

// The advertised revision is a hash of the file's mtime/ctime/size. Recomputing
// it locally gives a stronger statement than "a bundle came back": it proves the
// running server's graph row was built from the bytes now on disk.
const stat = statSync(CLIENT_PATH);
const localRev = artifactRevision(stat);
console.log(`on-disk rev:  ${localRev}  (mtime=${stat.mtimeMs} size=${stat.size})`);
console.log(`rev matches on-disk build: ${localRev === row.rev}`);

// 2. Fetch the advertised bundle and look for the engine.
const bundleUrl = new URL(`${BASE}/${row.url.replace(/^\/+/, "")}`);
const bundle = await withTimeout(bundleUrl, 8000, async (res) => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
});
const hasEngine = bundle.includes(MARKER);
const hasOldLightboxOnly = bundle.includes("data-wlf-patched") && !hasEngine;
console.log(`bundle bytes: ${bundle.length}`);
console.log(`engine marker present: ${hasEngine}`);
console.log(`old build only: ${hasOldLightboxOnly}`);

const ok = hasEngine && localRev === row.rev;
console.log(ok
  ? "RESULT: LIVE SERVER IS SERVING THE NEW ENGINE (no restart needed)"
  : hasEngine
    ? "RESULT: new engine served, but the rev does not match the on-disk file"
    : "RESULT: live server still serves the OLD bundle — restart DSH");
process.exit(ok ? 0 : 1);

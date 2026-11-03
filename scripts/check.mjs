import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.type, "module");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(manifest.version, pkg.version, "Release versions match");
assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "downloads", "scripting", "storage"]);
const instagramMatches = ["https://www.instagram.com/*", "https://instagram.com/*"];
assert.deepEqual(manifest.host_permissions, instagramMatches);
assert.equal(manifest.externally_connectable, undefined);
assert.equal(manifest.content_scripts.length, 1);
assert.deepEqual(manifest.content_scripts[0].matches, instagramMatches);
assert.deepEqual(manifest.content_scripts[0].js, ["src/shared/download-limits.js", "src/shared/profile-queue-config.js", ...["folder-writer.js", "profile-cache.js", "bulk-queue.js", "bulk-panel.js", "profile-job-runner.js", "profile-queue-panel.js", "profile-panel.js"].map(name => `src/content/${name}`)]);
assert.equal(manifest.content_scripts[0].all_frames, false);
assert.ok(!manifest.content_scripts[0].world || manifest.content_scripts[0].world === "ISOLATED");
const paths = new Set([
  manifest.background.service_worker, manifest.action.default_popup,
  ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((script) => [...script.js, ...(script.css || [])]),
]);
for (const path of paths) await access(join(root, path));
for (const [size, path] of Object.entries(manifest.icons)) {
  const png = await readFile(join(root, path));
  assert.equal(png.subarray(1, 4).toString(), "PNG", `${path} is a PNG`);
  assert.equal(png.readUInt32BE(16), Number(size), `${path} width`);
  assert.equal(png.readUInt32BE(20), Number(size), `${path} height`);
}
const popupPath = join(root, manifest.action.default_popup);
const html = await readFile(popupPath, "utf8");
assert.ok(!/<script\b[^>]*>\s*[^<\s]/i.test(html), "No inline scripts");
assert.ok(!/\son\w+\s*=/i.test(html), "No inline event handlers");
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  assert.ok(!match[1].includes(":"), "Popup assets are local");
  await access(join(dirname(popupPath), match[1]));
}
async function checkJavaScript(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") await checkJavaScript(path);
    if (entry.isFile() && /\.m?js$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    }
  }
}
await checkJavaScript(root);
console.log("Manifest, extension assets, PNG sizes, popup CSP compatibility, and JavaScript syntax passed.");

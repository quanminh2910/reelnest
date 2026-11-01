import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const context = vm.createContext({});
for (const filename of ["bulk-queue.js", "bulk-panel.js"]) {
  vm.runInContext(await readFile(new URL(`../src/content/${filename}`, import.meta.url), "utf8"), context);
}
const plain = value => JSON.parse(JSON.stringify(value));

test("reports preserve top-level and per-item diagnostics while omitting credentials and full paths", () => {
  const diagnostic = {
    queryName: "PolarisProfileReelsTabContentQuery_connection", adapterVersion: "profile-relay-v2",
    httpStatus: 400, serverCode: 1675030, variableNames: ["data", "scale"],
    executionMethod: "environment.execute", connectionPath: ["node", "xdt_api__v1__clips__user__connection_v2"],
    unsetVariableNames: ["after"],
    selectionKinds: ["LinkedField", "FragmentSpread"], fieldNames: ["node"],
    fragmentNames: ["ProfileReelsQuery"], connectionMatchCount: 0,
    serverMessage: "Required scale missing; x-csrftoken=secretCsrf; token=secretToken; https://cdninstagram.com/a.mp4?sig=secretSig\nCookie: csrftoken=first; sessionid=secretSession; arbitrary=secretCookie\nSet-Cookie: sessionid=secretSetCookie; Path=/\nrefresh_token=secretRefresh; id_token=secretId; session_key=secretKey",
    variables: { data: { target_user_id: "secretVariable" } }, headers: { Cookie: "secretCookie" },
  };
  const failure = { code: "QUERY_FAILED", stage: "discovery", message: "Query rejected token=secretMessage", diagnostic };
  const report = plain(context.ReelSaverBulkPanel.buildReport({
    jobId: "job-one", profile: { id: "123", username: "creator" }, mode: "batches", batchSize: 35,
    state: "incomplete", phase: "discovering", sourceExhausted: false, startedAt: 1,
    counts: { discovered: 1, saved: 0, failed: 1 }, error: failure,
    items: [{ mediaId: "1", shortcode: "B", state: "failed", attempts: 1, filename: "C:\\private\\creator_B.mp4",
      error: { ...failure, stage: "resolve", cleanupFailed: true, leftoverFilename: "C:\\private\\partial.mp4" } }],
  }));
  assert.equal(report.error.diagnostic.httpStatus, 400);
  assert.deepEqual(report.error.diagnostic.variableNames, ["data", "scale"]);
  assert.equal(report.error.diagnostic.executionMethod, "environment.execute");
  assert.deepEqual(report.error.diagnostic.connectionPath, ["node", "xdt_api__v1__clips__user__connection_v2"]);
  assert.deepEqual(report.error.diagnostic.unsetVariableNames, ["after"]);
  assert.deepEqual(report.error.diagnostic.selectionKinds, ["LinkedField", "FragmentSpread"]);
  assert.deepEqual(report.error.diagnostic.fieldNames, ["node"]);
  assert.deepEqual(report.error.diagnostic.fragmentNames, ["ProfileReelsQuery"]);
  assert.equal(report.error.diagnostic.connectionMatchCount, 0);
  assert.equal(report.items[0].error.diagnostic.serverCode, 1675030);
  assert.equal(report.items[0].error.diagnostic.executionMethod, "environment.execute");
  assert.deepEqual(report.items[0].error.diagnostic.connectionPath, report.error.diagnostic.connectionPath);
  assert.deepEqual(report.items[0].error.diagnostic.selectionKinds, report.error.diagnostic.selectionKinds);
  assert.equal(report.items[0].error.stage, "resolve");
  assert.equal(report.items[0].filename, "creator_B.mp4");
  assert.equal(report.items[0].error.leftoverFilename, "partial.mp4");
  assert.equal(JSON.stringify(report).includes("secret"), false);
  assert.equal(JSON.stringify(report).includes("https://"), false);
  assert.equal(JSON.stringify(report).includes("private"), false);
});

test("reports distinguish verified existing files from new physical saves", () => {
  const report = plain(context.ReelSaverBulkPanel.buildReport({
    jobId: "job-cache", profile: { id: "123", username: "creator" }, mode: "batches", batchSize: 35,
    state: "completed", phase: "downloading", sourceExhausted: true, startedAt: 1,
    counts: { discovered: 1, saved: 0, alreadyDownloaded: 1 },
    items: [{ mediaId: "1", shortcode: "B", state: "already_downloaded", attempts: 0,
      result: { filename: "creator_B (2).mp4", bytesWritten: 24, cacheHit: true } }],
  }));
  assert.equal(report.counts.saved, 0);
  assert.equal(report.counts.alreadyDownloaded, 1);
  assert.equal(report.items[0].reason, "already_downloaded");
  assert.equal(report.items[0].filename, "creator_B (2).mp4");
  assert.equal(report.items[0].bytesWritten, 24);
});

test("diagnostics are bounded and accept only named facts", () => {
  const diagnostic = plain(context.ReelSaverBulkQueue.sanitizeDiagnostic({
    queryName: "query", adapterVersion: "profile-relay-v2", httpStatus: 999, serverCode: "1675030",
    serverMessage: "x".repeat(2000), variableNames: ["scale", "not a name", "scale", ...Array.from({ length: 60 }, (_, i) => `name_${i}`)],
    executionMethod: "untrusted-method", connectionPath: ["node", "https://secret/path"],
    unsetVariableNames: ["after", "not a name", "after", ...Array.from({ length: 60 }, (_, i) => `unset_${i}`)],
    stack: "secretStack", response: { body: "secretBody" },
  }));
  assert.equal(diagnostic.serverMessage.length, 500);
  assert.equal(diagnostic.variableNames.length, 40);
  assert.equal(diagnostic.variableNames[0], "scale");
  assert.equal(diagnostic.variableNames.includes("not a name"), false);
  assert.equal(diagnostic.unsetVariableNames.length, 40);
  assert.equal(diagnostic.unsetVariableNames[0], "after");
  assert.equal(diagnostic.unsetVariableNames.includes("not a name"), false);
  assert.equal(diagnostic.serverCode, "1675030");
  assert.equal(Object.hasOwn(diagnostic, "httpStatus"), false);
  assert.equal(Object.hasOwn(diagnostic, "stack"), false);
  assert.equal(Object.hasOwn(diagnostic, "response"), false);
  assert.equal(Object.hasOwn(diagnostic, "executionMethod"), false);
  assert.equal(Object.hasOwn(diagnostic, "connectionPath"), false);
});

test("query execution facts keep their exact bounded path and freeze array snapshots", () => {
  const path = ["node", "clips"];
  const unset = ["after"];
  const diagnostic = context.ReelSaverBulkQueue.sanitizeDiagnostic({
    executionMethod: "fetchQuery", connectionPath: path, unsetVariableNames: unset,
  });
  path.push("changed");
  unset.push("changed");
  assert.deepEqual(plain(diagnostic.connectionPath), ["node", "clips"]);
  assert.deepEqual(plain(diagnostic.unsetVariableNames), ["after"]);
  assert.equal(diagnostic.executionMethod, "fetchQuery");
  assert.ok(Object.isFrozen(diagnostic.connectionPath));
  assert.ok(Object.isFrozen(diagnostic.unsetVariableNames));
  for (const connectionPath of [[], Array(9).fill("node"), ["node", null]]) {
    const clean = plain(context.ReelSaverBulkQueue.sanitizeDiagnostic({ executionMethod: "fetchQuery", connectionPath }));
    assert.equal(Object.hasOwn(clean, "connectionPath"), false);
  }
});

test("static query shape facts are bounded, isolated snapshots without AST payloads", () => {
  const inputNames = ["FragmentSpread", "FragmentSpread", "not a name", "https://secret/kind", null,
    { name: "secretValue" }, "N".repeat(200), "N".repeat(201), ...Array.from({ length: 80 }, (_, index) => `Name_${index}`)];
  const diagnostic = context.ReelSaverBulkQueue.sanitizeDiagnostic({
    selectionKinds: inputNames, fieldNames: inputNames, fragmentNames: inputNames,
    connectionMatchCount: 0, selections: [{ value: "secretASTValue" }],
  });
  inputNames.push("mutated");
  for (const name of ["selectionKinds", "fieldNames", "fragmentNames"]) {
    assert.equal(diagnostic[name].length, 60);
    assert.equal(diagnostic[name][0], "FragmentSpread");
    assert.equal(diagnostic[name][1].length, 200);
    assert.equal(diagnostic[name].includes("mutated"), false);
    assert.ok(Object.isFrozen(diagnostic[name]));
  }
  assert.equal(diagnostic.connectionMatchCount, 0);
  assert.equal(Object.hasOwn(diagnostic, "selections"), false);
  assert.equal(JSON.stringify(diagnostic).includes("secret"), false);
  for (const connectionMatchCount of [-1, 2001, 1.5, "2", NaN, null]) {
    const sanitized = context.ReelSaverBulkQueue.sanitizeDiagnostic({ fieldNames: ["node"], connectionMatchCount });
    assert.equal(Object.hasOwn(sanitized, "connectionMatchCount"), false);
  }
  assert.equal(context.ReelSaverBulkQueue.sanitizeDiagnostic({ connectionMatchCount: 2000 }).connectionMatchCount, 2000);
});

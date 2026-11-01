import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { profileSource } from "../src/instagram/profile-source.js";

const profile = { id: "1234567890", username: "example.creator" };
const queryName = "PolarisProfileReelsTabContentQuery_connection";

function relayFailure(message, source) {
  return Object.assign(new Error(message), source ? { source } : {});
}

async function discover({ failure, payload, action = "page", apiResponse, operation } = {}) {
  const descriptor = {
    params: { id: "CURRENT_LOADED_QUERY", name: queryName },
    fragment: { argumentDefinitions: [
      { kind: "LocalArgument", name: "data", defaultValue: null },
      { kind: "LocalArgument", name: "scale", defaultValue: null },
      { kind: "LocalArgument", name: "after", defaultValue: null },
    ] },
    ...(operation ? { operation } : {}),
  };
  const modules = {
    PolarisInstapi: { apiGet: async () => apiResponse },
    PolarisRelayEnvironment: { getStore: () => ({ getSource: () => ({ getRecordIDs: () => [] }) }) },
    [`${queryName}.graphql`]: descriptor,
    CometRelay: { fetchQuery: () => ({ subscribe(observer) {
      const subscription = { unsubscribe() {} };
      observer.start?.(subscription);
      if (failure) observer.error(failure);
      else { observer.next(payload); observer.complete(); }
      return subscription;
    } }) },
  };
  const window = {
    location: { href: `https://www.instagram.com/${profile.username}/reels/` },
    require: (name) => modules[name],
  };
  window.top = window;
  const context = {
    window, document: { querySelectorAll: () => [] }, URL, setTimeout, clearTimeout,
    request: { action, profile, ...(action === "resolve" ? { item: { mediaId: "1", shortcode: "B" } } : {}) },
  };
  const result = await vm.runInNewContext(`(${profileSource.toString()})(request)`, context);
  return JSON.parse(JSON.stringify(result));
}

test("RelayNetwork operation names do not turn query validation failures into connectivity failures", async () => {
  const result = await discover({ failure: relayFailure(
    `RelayNetwork: No data returned for operation ${queryName}: Variable $scale of required type Float! was not provided.`,
  ) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "QUERY_FAILED");
  assert.equal(result.error.stage, "discovery");
  assert.equal(result.error.retryable, false);
  assert.equal(result.error.diagnostic.queryName, queryName);
  assert.ok(result.error.diagnostic.variableNames.includes("scale"));
  assert.ok(result.error.diagnostic.adapterVersion);
});

test("a GraphQL connection field error is reported as a query failure", async () => {
  const field = "xdt_api__v1__clips__user__connection_v2";
  const result = await discover({ payload: {
    errors: [{ message: `Cannot query field ${field} on type Query.`, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }],
  } });
  assert.equal(result.error.code, "QUERY_FAILED");
  assert.equal(result.error.retryable, false);
  assert.match(result.error.diagnostic.serverMessage, /Cannot query field/);
  assert.equal(String(result.error.diagnostic.serverCode), "GRAPHQL_VALIDATION_FAILED");
});

test("structured query errors mentioning transport-like field names do not trigger network retries", async () => {
  for (const field of ["networkError", "offline"]) {
    const result = await discover({ payload: {
      errors: [{ message: `Cannot query field ${field} on type Query.`, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }],
    } });
    assert.equal(result.error.code, "QUERY_FAILED", field);
    assert.equal(result.error.retryable, false, field);
    assert.match(result.error.diagnostic.serverMessage, new RegExp(field));
  }
});

test("nested Relay source errors preserve bounded server details without request variables", async () => {
  const result = await discover({ failure: relayFailure(
    `RelayNetwork: No data returned for operation ${queryName}.`,
    {
      status: 400,
      errors: [{ message: "Variable $scale was not provided.", code: 1675030 }],
      variables: { data: { target_user_id: profile.id }, secret: "requestVariableMustNotAppear" },
    },
  ) });
  const diagnostic = result.error.diagnostic;
  assert.equal(result.error.code, "QUERY_FAILED");
  assert.equal(diagnostic.httpStatus, 400);
  assert.equal(String(diagnostic.serverCode), "1675030");
  assert.match(diagnostic.serverMessage, /scale/);
  assert.ok(diagnostic.variableNames.includes("scale"));
  assert.equal(JSON.stringify(result.error).includes("requestVariableMustNotAppear"), false);
  assert.equal(Object.hasOwn(diagnostic, "variables"), false);
});

test("nested HTTP authentication and rate-limit responses keep their recovery policy", async () => {
  const auth = await discover({ failure: relayFailure("RelayNetwork: Query rejected.", {
    status: 401, errors: [{ message: "login_required" }],
  }) });
  assert.equal(auth.error.code, "LOGIN_REQUIRED");
  assert.equal(auth.error.retryable, false);
  const limited = await discover({ failure: relayFailure("RelayNetwork: Query rejected.", {
    status: 429, retry_after: 8, errors: [{ message: "Too many requests" }],
  }) });
  assert.equal(limited.error.code, "RATE_LIMITED");
  assert.equal(limited.error.retryable, false);
  assert.equal(limited.error.retryAfterMs, 8000);
});

test("classified identify and resolve responses preserve their original HTTP diagnostics", async () => {
  const identified = await discover({ action: "identify", apiResponse: { data: { statusCode: 401, message: "login_required" } } });
  assert.equal(identified.error.code, "LOGIN_REQUIRED");
  assert.equal(identified.error.stage, "identify");
  assert.equal(identified.error.diagnostic.httpStatus, 401);
  assert.equal(identified.error.diagnostic.serverMessage, "login_required");

  const resolved = await discover({ action: "resolve", apiResponse: {
    status: 429, message: "Too many requests", retry_after: 8,
  } });
  assert.equal(resolved.error.code, "RATE_LIMITED");
  assert.equal(resolved.error.stage, "resolve");
  assert.equal(resolved.error.retryAfterMs, 8000);
  assert.equal(resolved.error.diagnostic.httpStatus, 429);
  assert.equal(resolved.error.diagnostic.serverMessage, "Too many requests");
});

test("third-party string error codes cannot bypass classification or diagnostic sanitization", async () => {
  const result = await discover({ failure: Object.assign(new Error("Client rejected token=secretThirdPartyToken"), {
    code: "THIRD_PARTY_ERROR", retryable: true,
    diagnostic: { serverMessage: "secretUntrustedDiagnostic", variables: { secret: "secretVariableValue" } },
  }) });
  assert.equal(result.error.code, "ADAPTER_ERROR");
  assert.equal(result.error.retryable, false);
  const output = JSON.stringify(result.error);
  for (const secret of ["secretThirdPartyToken", "secretUntrustedDiagnostic", "secretVariableValue"]) {
    assert.equal(output.includes(secret), false, secret);
  }
});

test("real transport and HTTP server failures are still retryable", async () => {
  for (const failure of [new TypeError("Failed to fetch"), new Error("Network request failed"),
    relayFailure("RelayNetwork: Request failed.", { status: 503 })]) {
    const result = await discover({ failure });
    assert.equal(result.error.code, "NETWORK_ERROR");
    assert.equal(result.error.retryable, true);
  }
});

test("query diagnostics redact credentials and signed addresses rather than exporting raw payloads", async () => {
  const secrets = ["secretCsrf", "secretLsd", "secretDtsg", "secretToken", "secretCookie", "secretSignature", "secretExtension"];
  const result = await discover({ failure: relayFailure(`RelayNetwork: ${queryName} rejected.`, {
    status: 400,
    errors: [{
      message: "Invalid request x-csrftoken=secretCsrf; lsd=secretLsd; fb_dtsg=secretDtsg; token=secretToken; cookie=secretCookie; url=https://scontent.cdninstagram.com/video.mp4?sig=secretSignature",
      extensions: { code: "BAD_REQUEST", token: "secretExtension" },
    }],
  }) });
  assert.equal(result.error.code, "QUERY_FAILED");
  const text = JSON.stringify(result.error);
  for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
  assert.equal(text.includes("https://"), false);
  assert.ok(result.error.diagnostic.serverMessage.length <= 500);
});

test("query diagnostics redact session cookies after the first cookie pair", async () => {
  const result = await discover({ failure: relayFailure(`RelayNetwork: ${queryName} rejected.`, {
    status: 400,
    errors: [{ message: "Cookie: csrftoken=secretFirstCookie; sessionid=secretSessionCookie" }],
  }) });
  const output = JSON.stringify(result.error);
  assert.equal(output.includes("secretFirstCookie"), false);
  assert.equal(output.includes("secretSessionCookie"), false);
});

test("pre-request compatibility errors preserve static query structure without copying values", async () => {
  const field = "xdt_api__v1__clips__user__connection_v2";
  const result = await discover({ operation: {
    kind: "Operation", name: queryName,
    argumentDefinitions: [
      { kind: "LocalArgument", name: "first", defaultValue: null },
      { kind: "LocalArgument", name: "id", defaultValue: null },
      { kind: "LocalArgument", name: "privateInput", defaultValue: "secretDefaultValue" },
    ],
    selections: [{ kind: "UnsupportedSelection", fragment: {
      kind: "SplitOperation", name: "ProfileReels_normalization",
      selections: [{ kind: "LinkedField", name: field, plural: false,
        args: [{ kind: "Literal", name: "input", value: "secretLiteralValue" }], selections: [] }],
    } }],
  } });
  assert.equal(result.error.code, "SCHEMA_CHANGED");
  const diagnostic = result.error.diagnostic;
  assert.equal(diagnostic.connectionMatchCount, 0);
  assert.ok(diagnostic.selectionKinds.includes("UnsupportedSelection"));
  assert.ok(diagnostic.fieldNames.includes(field));
  assert.ok(diagnostic.fragmentNames.includes("ProfileReels_normalization"));
  assert.ok(diagnostic.variableNames.includes("first"));
  assert.ok(diagnostic.unsetVariableNames.includes("id"));
  assert.equal(JSON.stringify(diagnostic).includes("secret"), false);
});

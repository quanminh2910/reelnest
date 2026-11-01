import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { profileSource } from "../src/instagram/profile-source.js";

const profile = { id: "1234567890", username: "example.creator" };
const queryName = "PolarisProfileReelsTabContentQuery_connection";
const local = (name, defaultValue) => ({ kind: "LocalArgument", name, defaultValue });

function fixture({ operationArguments = [], fragmentArguments = [], pixelRatio = 2,
  devicePixelRatio = 1.25, assertVariables = () => {}, providedVariables } = {}) {
  const state = { calls: [], providerCalls: 0, pixelCalls: 0 };
  const descriptor = {
    params: { id: "CURRENT_LOADED_DESCRIPTOR", name: queryName, operationKind: "query",
      ...(providedVariables ? { providedVariables: { ...providedVariables,
        __relay_internal__pv__test: { get() { state.providerCalls++; return true; } } } } : {}) },
    fragment: { argumentDefinitions: fragmentArguments },
    operation: { argumentDefinitions: operationArguments },
  };
  const environment = { getStore: () => ({ getSource: () => ({ getRecordIDs: () => [] }) }) };
  const modules = {
    PolarisRelayEnvironment: environment,
    [`${queryName}.graphql`]: descriptor,
    ...(pixelRatio !== null ? { WebPixelRatio: { get() { state.pixelCalls++; return pixelRatio; } } } : {}),
    CometRelay: { fetchQuery(env, query, variables) {
      assert.equal(env, environment);
      assert.equal(query, descriptor);
      state.calls.push(variables);
      assertVariables(variables);
      return { subscribe(observer) {
        const subscription = { unsubscribe() {} };
        observer.start?.(subscription);
        observer.next({ xdt_api__v1__clips__user__connection_v2: {
          edges: [], page_info: { has_next_page: false, end_cursor: null },
        } });
        observer.complete();
        return subscription;
      } };
    } },
  };
  const window = {
    location: { href: `https://www.instagram.com/${profile.username}/reels/` },
    devicePixelRatio,
    require(name) { if (name in modules) return modules[name]; throw new Error("Module not loaded"); },
  };
  window.top = window;
  const context = { window, document: { querySelectorAll: () => [] }, URL, setTimeout, clearTimeout };
  return { context, state, descriptor };
}

async function run(f, cursor = null) {
  f.context.request = { action: "page", profile, cursor };
  const result = await vm.runInNewContext(`(${profileSource.toString()})(request)`, f.context);
  return JSON.parse(JSON.stringify(result));
}

test("a required null scale is filled from Instagram's current WebPixelRatio module", async () => {
  const f = fixture({
    operationArguments: [local("scale", null)],
    fragmentArguments: [local("scale", null)],
    assertVariables(variables) {
      if (variables.scale == null) throw new Error(`${queryName}: Required variable scale is null`);
      assert.equal(variables.scale, 2);
    },
  });
  assert.equal((await run(f)).ok, true);
  assert.equal(f.state.pixelCalls, 1);
});

test("declared scale falls back to the current window pixel ratio when the module is unavailable", async () => {
  const f = fixture({ operationArguments: [local("scale", null)], pixelRatio: null, devicePixelRatio: 1.5,
    assertVariables: variables => assert.equal(variables.scale, 1.5) });
  assert.equal((await run(f)).ok, true);
});

test("invalid runtime pixel ratios use a finite positive scale", async () => {
  for (const pixelRatio of [0, -1, NaN, Infinity]) {
    const f = fixture({ operationArguments: [local("scale", null)], pixelRatio, devicePixelRatio: 0,
      assertVariables: variables => assert.equal(variables.scale, 1) });
    assert.equal((await run(f)).ok, true, String(pixelRatio));
  }
});

test("operation-only defaults are retained alongside fragment defaults and fixed profile data", async () => {
  const f = fixture({
    operationArguments: [local("scale", null), local("operationFlag", true), local("data", {
      include_feed_video: false, page_size: 99, target_user_id: "wrong-profile", profile_filter: "keep",
    })],
    fragmentArguments: [local("fragmentFlag", "keep")],
    assertVariables(variables) {
      assert.equal(variables.operationFlag, true);
      assert.equal(variables.fragmentFlag, "keep");
      assert.equal(variables.data.profile_filter, "keep");
      assert.equal(variables.data.include_feed_video, true);
      assert.equal(variables.data.page_size, 12);
      assert.equal(variables.data.target_user_id, profile.id);
    },
  });
  assert.equal((await run(f)).ok, true);
});

test("a declared positive scale default is preserved instead of replaced", async () => {
  const f = fixture({ operationArguments: [local("scale", 1.5)],
    fragmentArguments: [local("scale", 1.5)], pixelRatio: 3,
    assertVariables: variables => assert.equal(variables.scale, 1.5) });
  assert.equal((await run(f)).ok, true);
});

test("an undeclared scale is not injected and pagination stays at the query root", async () => {
  const f = fixture({ operationArguments: [local("after", null)], fragmentArguments: [local("data", {})],
    assertVariables(variables) {
      assert.equal(variables.scale, undefined);
      assert.equal(variables.after, "NEXT_PAGE_CURSOR");
      assert.equal(variables.data.after, undefined);
    },
  });
  assert.equal((await run(f, "NEXT_PAGE_CURSOR")).ok, true);
  assert.equal(f.state.pixelCalls, 0);
});

test("provided-variable evaluation is left to the actual Relay runtime", async () => {
  const f = fixture({ operationArguments: [local("scale", null)], providedVariables: {} });
  assert.equal((await run(f)).ok, true);
  assert.equal(f.state.providerCalls, 0, "adapter must not evaluate providers independently of Relay");
  assert.ok(f.descriptor.params.providedVariables.__relay_internal__pv__test);
});

test("the original source profile binding is retained before building query variables", async () => {
  const f = fixture({ operationArguments: [local("scale", null)] });
  f.context.window.location.href = "https://www.instagram.com/another_profile/reels/";
  assert.equal((await run(f)).error.code, "PROFILE_CHANGED");
  assert.equal(f.state.calls.length, 0);
});

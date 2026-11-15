import assert from "node:assert/strict";
import test from "node:test";
import {
  checkNodeVersion,
  minimumNodeVersion,
  nodeVersion,
} from "../common.mjs";

test("releases require the exact .nvmrc Node version", () => {
  assert.deepEqual(checkNodeVersion(nodeVersion), {});
  assert.match(checkNodeVersion("99.0.0").error, /Use Node/);
  if (minimumNodeVersion !== nodeVersion)
    assert.match(checkNodeVersion(minimumNodeVersion).error, /Use Node/);
});

test("development checks accept supported versions with a warning", () => {
  assert.deepEqual(checkNodeVersion(nodeVersion, { exact: false }), {});
  assert.match(
    checkNodeVersion("99.0.0", { exact: false }).warning,
    /releases require/,
  );
  assert.equal(
    checkNodeVersion(minimumNodeVersion, { exact: false }).error,
    undefined,
  );
});

test("development checks reject versions below server engines", () => {
  for (const version of ["20.19.0", "22.12.9", "21.99.99"])
    assert.match(checkNodeVersion(version, { exact: false }).error, /or newer/);
});

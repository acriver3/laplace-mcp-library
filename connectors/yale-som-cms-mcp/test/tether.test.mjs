import assert from "node:assert/strict";
import { test } from "node:test";
import { OwnedTargetGateway } from "../dist/tether.js";

test("a protocol-level worker script exception rejects guard setup before it can resume", async () => {
  const gateway = Object.create(OwnedTargetGateway.prototype), calls = [];
  gateway.rpc = async (method) => {
    calls.push(method);
    return method === "Runtime.evaluate" ? { exceptionDetails: { text: "Sanitized fixture exception" } } : {};
  };
  await assert.rejects(() => gateway.guardWorker("owned-fixture"), /Worker transport guard failed/);
  assert.deepEqual(calls, ["Runtime.enable", "Runtime.addBinding", "Runtime.evaluate"]);
});

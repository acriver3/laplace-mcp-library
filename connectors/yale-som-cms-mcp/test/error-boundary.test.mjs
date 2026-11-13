import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { CmsError, errorResult } from "../dist/types.js";

test("unexpected browser errors never expose Cookie headers, signed URLs or nested causes", () => {
  const secret = "fixture-secret-value";
  const signed = "https://storage.example/file.pdf?sig=" + secret;
  const error = new Error(
    "apiRequestContext.get: connection reset\nCall log:\nGET " +
      signed +
      "\nCookie: .ASPXAUTH.Shared=" +
      secret +
      "\nAuthorization: Bearer " +
      secret,
    { cause: new Error("Nested credentials: " + secret) },
  );
  const result = errorResult(error);
  assert.equal(result.code, "cms_error");
  assert.match(result.message, /CMS operation failed/);
  const serialized = JSON.stringify(result);
  for (const excluded of [
    secret,
    signed,
    "Cookie",
    "Authorization",
    "Call log",
    "stack",
    "cause",
  ])
    assert.equal(serialized.includes(excluded), false, excluded);
  assert.deepEqual(Object.keys(result).sort(), ["code", "message"]);
});

test("non-Error throwables are neither echoed nor stringified", () => {
  const result = errorResult({
    message: "fixture-secret",
    toString() {
      throw new Error("must not stringify unknown errors");
    },
  });
  assert.equal(result.code, "cms_error");
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
});

test("intentional CMS errors and validation issues retain their existing structured contract", () => {
  assert.deepEqual(
    errorResult(
      new CmsError("account_changed", "Prepare a new preview.", {
        phase: "confirmation",
      }),
    ),
    {
      code: "account_changed",
      message: "Prepare a new preview.",
      details: { phase: "confirmation" },
    },
  );
  const validation = z
    .object({ limit: z.number().int().positive() })
    .safeParse({ limit: 0 });
  assert.equal(validation.success, false);
  const result = errorResult(validation.error);
  assert.equal(result.code, "invalid_input");
  assert.deepEqual(result.details, validation.error.issues);
});

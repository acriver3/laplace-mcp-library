import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { observeCompletion } from "../dist/completion.js";
import { CMS_ORIGIN } from "../dist/types.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const options = { timeoutMs: 3000, settleMs: 40 };
async function fixture(
  body,
  callback,
  respond = (route) => route.fulfill({ status: 204, body: "" }),
) {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(
      url.origin,
      CMS_ORIGIN,
      "fixtures never contact another origin",
    );
    if (route.request().isNavigationRequest())
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><main>" + body + "</main>",
      });
    return respond(route);
  });
  try {
    await page.goto(CMS_ORIGIN + "/tasks/");
    await callback(page);
  } finally {
    await browser.close();
  }
}
const form =
  '<form id="editor"><button type="button" id="save">Save</button></form>';

test("a disappearing form cannot finish before all captured writes finish", async () => {
  const started = deferred(),
    release = deferred();
  let completed = false,
    actions = 0,
    requests = 0;
  await fixture(
    form,
    async (page) => {
      const observing = observeCompletion(
        page,
        async () => {
          actions++;
          await page.evaluate(() => {
            document.querySelector("#editor").remove();
            void fetch("/api/write", { method: "POST" });
          });
          return "clicked once";
        },
        { ...options, form: page.locator("#editor") },
      ).then((result) => {
        completed = true;
        return result;
      });
      await started.promise;
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(completed, false);
      release.resolve();
      assert.equal(await observing, "clicked once");
      assert.equal(actions, 1);
      assert.equal(requests, 1);
    },
    async (route) => {
      requests++;
      started.resolve();
      await release.promise;
      await route.fulfill({ status: 204, body: "" });
    },
  );
});

test("reviewed read POSTs and static success text do not establish completion", async () => {
  await fixture(form + "<p>Successfully saved</p>", async (page) => {
    await assert.rejects(
      () =>
        observeCompletion(
          page,
          () =>
            page.evaluate(async () => {
              await fetch("/api/internal/tasks/post-query", { method: "POST" });
              await fetch("/api/read");
            }),
          { ...options, timeoutMs: 200, finalControl: page.locator("#save") },
        ),
      { code: "submission_uncertain" },
    );
    assert.equal(await page.locator("#save").count(), 1);
  });
});

test("form disappearance without HTTP transport is observed without navigating", async () => {
  await fixture(form, async (page) => {
    const url = page.url();
    const result = await observeCompletion(
      page,
      () =>
        page.locator("#editor").evaluate((e) => {
          e.remove();
          return 42;
        }),
      { ...options, form: page.locator("#editor") },
    );
    assert.equal(result, 42);
    assert.equal(page.url(), url);
  });
});

test("only an explicitly expected same-origin URL counts as navigation evidence", async () => {
  await fixture(form, async (page) => {
    await observeCompletion(
      page,
      () =>
        page.evaluate(() => {
          location.hash = "done";
        }),
      { ...options, expectedUrl: CMS_ORIGIN + "/tasks/#done" },
    );
    await assert.rejects(
      () =>
        observeCompletion(
          page,
          () =>
            page.evaluate(() => {
              location.hash = "unrelated";
            }),
          {
            ...options,
            timeoutMs: 200,
            expectedUrl: CMS_ORIGIN + "/tasks/#expected",
          },
        ),
      { code: "submission_uncertain" },
    );
  });
});

test("tracking includes uploads during the action and a later final request", async () => {
  const finalStarted = deferred(),
    release = deferred();
  const paths = [];
  let done = false;
  await fixture(
    form,
    async (page) => {
      const observing = observeCompletion(
        page,
        () =>
          page.evaluate(async () => {
            await fetch("/api/upload", { method: "POST" });
            document.querySelector("#editor").remove();
            void fetch("/api/submit", { method: "POST" });
          }),
        { ...options, form: page.locator("#editor") },
      ).then(() => {
        done = true;
      });
      await finalStarted.promise;
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(done, false);
      release.resolve();
      await observing;
      assert.deepEqual(paths, ["/api/upload", "/api/submit"]);
    },
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      paths.push(path);
      if (path === "/api/submit") {
        finalStarted.resolve();
        await release.promise;
      }
      await route.fulfill({ status: 204, body: "" });
    },
  );
});

test("a whole delete-confirmation flow waits for its final request once", async () => {
  let deletes = 0;
  const html =
    '<button id="delete" onclick="document.querySelector(\'#confirm\').hidden=false">Delete</button><div id="confirm" hidden><button id="yes" onclick="void fetch(\'/api/delete\',{method:\'DELETE\'}).then(()=>document.querySelector(\'#confirm\').remove())">Yes</button></div>';
  await fixture(
    html,
    async (page) => {
      await observeCompletion(
        page,
        async () => {
          await page.locator("#delete").click();
          await page.locator("#yes").click();
        },
        { ...options, finalControl: page.locator("#delete") },
      );
      assert.equal(deletes, 1);
      assert.equal(await page.locator("#confirm").count(), 0);
    },
    async (route) => {
      deletes++;
      await new Promise((r) => setTimeout(r, 80));
      await route.fulfill({ status: 204, body: "" });
    },
  );
});

test("failed transport is uncertain; HTTP rejection only allows authoritative verification", async () => {
  await fixture(
    form,
    async (page) => {
      const listeners = page.listenerCount("request");
      await assert.rejects(
        () =>
          observeCompletion(
            page,
            () =>
              page.evaluate(() => {
                void fetch("/api/fail", { method: "PATCH" }).catch(() => {});
              }),
            options,
          ),
        (error) =>
          error.code === "submission_uncertain" &&
          error.details.reason === "request_failed",
      );
      assert.equal(page.listenerCount("request"), listeners);
    },
    (route) => route.abort("failed"),
  );
  await fixture(
    form,
    async (page) => {
      const result = await observeCompletion(
        page,
        async () => {
          await page.evaluate(() => {
            void fetch("/api/rejected", { method: "POST" });
          });
          return { clicked: true };
        },
        options,
      );
      assert.deepEqual(result, { clicked: true }); // No operation-success claim is synthesized.
    },
    (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/json",
        body: '{"error":"validation"}',
      }),
  );
});

test("timeout never retries, cleans observers, and awaits the bounded action first", async () => {
  const started = deferred(),
    release = deferred();
  let actions = 0;
  await fixture(
    form,
    async (page) => {
      const baseline = [
        "request",
        "requestfinished",
        "requestfailed",
        "response",
      ].map((event) => page.listenerCount(event));
      const actionDone = deferred();
      const observing = observeCompletion(
        page,
        async () => {
          actions++;
          await page.evaluate(() => {
            void fetch("/api/hung", { method: "POST" }).catch(() => {});
          });
          await new Promise((r) => setTimeout(r, 120));
          actionDone.resolve();
        },
        { timeoutMs: 100, settleMs: 20 },
      );
      await started.promise;
      await actionDone.promise;
      await assert.rejects(
        () => observing,
        (error) =>
          error.code === "submission_uncertain" &&
          error.details.reason === "completion_timeout",
      );
      assert.equal(actions, 1);
      assert.deepEqual(
        ["request", "requestfinished", "requestfailed", "response"].map(
          (event) => page.listenerCount(event),
        ),
        baseline,
      );
      release.resolve();
    },
    async (route) => {
      started.resolve();
      await release.promise;
      await route.fulfill({ status: 204, body: "" }).catch(() => {});
    },
  );
});

test("the quiet period captures a delayed request after the form disappears", async () => {
  const started = deferred(),
    release = deferred();
  let done = false;
  await fixture(
    form,
    async (page) => {
      const observing = observeCompletion(
        page,
        () =>
          page.evaluate(() => {
            document.querySelector("#editor").remove();
            setTimeout(() => {
              void fetch("/api/delayed-final", { method: "POST" });
            }, 60);
          }),
        { ...options, settleMs: 150, form: page.locator("#editor") },
      ).then(() => {
        done = true;
      });
      await started.promise;
      await new Promise((r) => setTimeout(r, 170));
      assert.equal(done, false);
      release.resolve();
      await observing;
    },
    async (route) => {
      started.resolve();
      await release.promise;
      await route.fulfill({ status: 200, body: "{}" });
    },
  );
});

test("an additional matching form is ambiguity, not disappearance", async () => {
  await fixture(form, async (page) => {
    await assert.rejects(
      () =>
        observeCompletion(
          page,
          () =>
            page.evaluate(() => {
              document
                .querySelector("main")
                .insertAdjacentHTML(
                  "beforeend",
                  '<form><button type="button">Other form</button></form>',
                );
            }),
          { ...options, timeoutMs: 200, form: page.locator("form") },
        ),
      { code: "submission_uncertain" },
    );
    assert.equal(await page.locator("form").count(), 2);
  });
});

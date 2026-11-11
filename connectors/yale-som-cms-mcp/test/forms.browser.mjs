import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { chromium } from "playwright-core";

import {
  fieldLocator,
  fillFields,
  formScope,
  inspectFields,
  validateFields,
} from "../dist/forms.js";
let browser;
before(async () => {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
});
after(async () => {
  await browser?.close();
});

async function fixture(t, html) {
  const context = await browser.newContext();
  await context.route("**/*", (route) => route.abort());
  const page = await context.newPage();
  await page.setContent(html);
  t.after(() => context.close());
  await page.evaluate(() => {
    window.fieldChanges = 0;
    document.addEventListener("change", () => {
      window.fieldChanges++;
    });
    document.addEventListener("input", () => {
      window.fieldChanges++;
    });
  });
  return { page, scope: page.locator("main") };
}
const rejects = (promise, code) =>
  assert.rejects(promise, (error) => error.code === code);

test("form discovery rejects duplicate names and does not trigger field changes", async (t) => {
  const { page, scope } = await fixture(
    t,
    '<main><input name="email" value="one"><input name="email" value="two"></main>',
  );
  await rejects(inspectFields(scope), "ambiguous_field");
  assert.equal(await page.evaluate(() => window.fieldChanges), 0);
  assert.deepEqual(
    await scope
      .locator("input")
      .evaluateAll((nodes) => nodes.map((n) => n.value)),
    ["one", "two"],
  );
});

test("required checkbox is discovered unchecked and cannot be prepared as false", async (t) => {
  const { scope } = await fixture(
    t,
    '<main><label><input type="checkbox" name="consent" required>I accept</label></main>',
  );
  const fields = await inspectFields(scope);
  assert.equal(fields[0].required, true);
  assert.equal(fields[0].value, false);
  assert.throws(
    () => validateFields(fields, { consent: false }, []),
    (e) => e.code === "required_field",
  );
  validateFields(fields, { consent: true }, []);
});

test("named radio group has one required field and selects exactly the approved enabled option", async (t) => {
  const { page, scope } = await fixture(
    t,
    '<main><form><label><input type="radio" name="reply" value="old" disabled>Old</label><label><input type="radio" name="reply" value="yes" required>Yes</label><label><input type="radio" name="reply" value="no">No</label></form></main>',
  );
  const fields = await inspectFields(scope);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].required, true);
  assert.equal(fields[0].read_only, false);
  assert.equal(fields[0].options.length, 3);
  assert.equal(await page.evaluate(() => window.fieldChanges), 0);
  validateFields(fields, { reply: "Yes" }, []);
  await fillFields(scope, fields, { reply: "Yes" });
  assert.equal(await scope.locator('input[value="yes"]').isChecked(), true);
  assert.equal(await scope.locator('input[value="no"]').isChecked(), false);
});

test("same radio name across separate form owners and duplicate radio values are ambiguous", async (t) => {
  const { page, scope } = await fixture(
    t,
    '<main><form><input type="radio" name="reply" value="yes"></form><form><input type="radio" name="reply" value="no"></form></main>',
  );
  await rejects(inspectFields(scope), "ambiguous_field");
  await page.setContent(
    '<main><form><input type="radio" name="reply" value="yes"><input type="radio" name="reply" value="yes"></form></main>',
  );
  await rejects(inspectFields(scope), "ambiguous_field");
});

test("hidden native select resolves through visible named tt-input without matching its wrapper", async (t) => {
  const { page, scope } = await fixture(
    t,
    '<main><tt-input name="industry" label="Industry" style="display:block"><select name="industry" style="display:none"><option value="">Choose</option><option value="tech">Technology</option><optgroup label="Old" disabled><option value="old">Unavailable</option></optgroup></select><button type="button">Choose</button></tt-input></main>',
  );
  const fields = await inspectFields(scope);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, "select");
  assert.equal(fields[0].options.find((o) => o.value === "old").disabled, true);
  assert.equal(
    await (await fieldLocator(scope, fields[0])).evaluate((e) => e.tagName),
    "SELECT",
  );
  assert.equal(await page.evaluate(() => window.fieldChanges), 0);
  await fillFields(scope, fields, { industry: "Technology" });
  assert.equal(await scope.locator("select").inputValue(), "tech");
  assert.equal(await page.evaluate(() => window.fieldChanges), 2);
});

test("wrapper-only names locate hidden dropdowns; duplicate controls within wrapper fail", async (t) => {
  const { page, scope } = await fixture(
    t,
    '<main><tt-input name="status" label="Status" style="display:block"><select style="display:none"><option value="one">One</option><option value="two">Two</option></select><span>Status</span></tt-input></main>',
  );
  const fields = await inspectFields(scope);
  await fillFields(scope, fields, { status: "two" });
  assert.equal(await scope.locator("select").inputValue(), "two");
  await page.setContent(
    '<main><tt-input name="status" label="Status" style="display:block"><select><option>One</option></select><select><option>Two</option></select></tt-input></main>',
  );
  await rejects(inspectFields(scope), "ambiguous_field");
});

test("late duplicate field is rejected before an earlier autosaving field changes", async (t) => {
  const { page, scope } = await fixture(
    t,
    '<main><input name="first" value="before"><input name="later" value="before"></main>',
  );
  const fields = await inspectFields(scope);
  await scope.evaluate((el) => {
    const clone = el.querySelector('[name="later"]').cloneNode();
    el.append(clone);
  });
  await rejects(
    fillFields(scope, fields, { first: "after", later: "after" }),
    "ambiguous_field",
  );
  assert.equal(await scope.locator('[name="first"]').inputValue(), "before");
  assert.equal(await page.evaluate(() => window.fieldChanges), 0);
});

test("unknown or newly disabled later field prevents all earlier edits", async (t) => {
  const { page, scope } = await fixture(
    t,
    '<main><input name="first" value="before"><input name="later" value="before"></main>',
  );
  const fields = await inspectFields(scope);
  await rejects(
    fillFields(scope, fields, { first: "after", unknown: "after" }),
    "invalid_field",
  );
  await scope.locator('[name="later"]').evaluate((el) => {
    el.disabled = true;
  });
  await rejects(
    fillFields(scope, fields, { first: "after", later: "after" }),
    "invalid_field",
  );
  assert.equal(await scope.locator('[name="first"]').inputValue(), "before");
  assert.equal(await page.evaluate(() => window.fieldChanges), 0);
});

test("file fields bind their exact named or wrapper control and ambiguous fallback fails", async (t) => {
  const { page, scope } = await fixture(
    t,
    '<main><input type="file" name="resume"><input type="file" name="cover"></main>',
  );
  const fields = await inspectFields(scope);
  assert.equal(
    await (
      await fieldLocator(
        scope,
        fields.find((f) => f.id === "resume"),
      )
    ).getAttribute("name"),
    "resume",
  );
  await page.setContent(
    '<main><tt-input name="resume" style="display:block"><input type="file"></tt-input></main>',
  );
  const wrapped = await inspectFields(scope);
  assert.equal(
    await (await fieldLocator(scope, wrapped[0])).getAttribute("type"),
    "file",
  );
  await page.setContent('<main><input type="file"><input type="file"></main>');
  await rejects(inspectFields(scope), "ambiguous_field");
  await rejects(
    fieldLocator(scope, {
      id: "file",
      label: "file",
      type: "file",
      required: false,
    }),
    "ambiguous_field",
  );
});

test("nested form wrappers identify one form; sibling dialogs and multiple main regions fail", async (t) => {
  const { page } = await fixture(
    t,
    '<main></main><div class="modal"><section role="dialog"><input name="answer"></section></div>',
  );
  assert.equal(await (await formScope(page)).getAttribute("role"), "dialog");
  await page.setContent(
    '<main></main><section role="dialog"><input></section><section role="dialog"><input></section>',
  );
  await rejects(formScope(page), "ambiguous_form");
  await page.setContent("<main>one</main><main>two</main>");
  await rejects(formScope(page), "page_changed");
});

test("duplicate generated labels, anonymous required fields, and duplicate editors fail closed", async (t) => {
  const { page, scope } = await fixture(
    t,
    "<main><label>Answer<input></label><label>Answer<input></label></main>",
  );
  await rejects(inspectFields(scope), "ambiguous_field");
  await page.setContent("<main><input required></main>");
  await rejects(inspectFields(scope), "ambiguous_field");
  await page.setContent(
    '<main><iframe title="Editor, Summary"></iframe><iframe title="Editor, Summary"></iframe></main>',
  );
  await rejects(inspectFields(scope), "ambiguous_field");
});

test("approved rich-text updates bind the same editor title discovered in the preview", async (t) => {
  const { page, scope } = await fixture(
    t,
    '<main><iframe title="Editor, Summary"></iframe></main>',
  );
  await page.locator("iframe").evaluate((e) => {
    e.contentDocument.body.contentEditable = "true";
    e.contentDocument.body.innerText = "Before";
  });
  const fields = await inspectFields(scope);
  assert.equal(fields[0].id, "editor:Summary");
  await fillFields(scope, fields, { "editor:Summary": "Approved summary" });
  assert.equal(
    await page
      .locator("iframe")
      .evaluate((e) => e.contentDocument.body.innerText),
    "Approved summary",
  );
});

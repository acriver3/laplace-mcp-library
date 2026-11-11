import type { Locator, Page } from "playwright-core";

import { CmsError, type FormField, type FieldValue } from "./types.js";

export async function formScope(page: Page): Promise<Locator> {
  const dialogs = page.locator(
    ".modal:visible,[role=dialog]:visible,.slideout:visible,tt-form-slideout:visible",
  );
  const count = await dialogs.count();
  if (count) {
    const leaf = dialogs.last();
    // Nested dialog wrappers describe one form. Two visible sibling forms are ambiguous.
    const sameForm = await leaf.evaluate((last) => {
      const all = [
        ...document.querySelectorAll(
          ".modal,[role=dialog],.slideout,tt-form-slideout",
        ),
      ].filter((e) => e.getClientRects().length);
      return all.every((e) => e === last || e.contains(last));
    });
    if (!sameForm)
      throw new CmsError(
        "ambiguous_form",
        "CMS exposes multiple visible forms. Close the other form before continuing.",
      );
    return leaf;
  }
  const main = page.locator("[role=main],main");
  if ((await main.count()) === 1) return main;
  throw new CmsError(
    "page_changed",
    "CMS did not expose one expected content region.",
  );
}
export async function clickNamed(scope: Locator, names: RegExp): Promise<void> {
  const controls = scope.locator("button,a,[role=button],input[type=submit]");
  const matches: Locator[] = [];
  for (let i = 0; i < (await controls.count()); i++) {
    const el = controls.nth(i);
    if (!(await el.isVisible())) continue;
    const label = await el.evaluate((e) =>
      (
        e.getAttribute("aria-label") ||
        e.textContent ||
        (e as HTMLInputElement).value ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (names.test(label)) matches.push(el);
  }
  if (matches.length !== 1)
    throw new CmsError(
      "action_unavailable",
      "CMS did not expose one unambiguous permitted action.",
      { expected: names.source, count: matches.length },
    );
  if (await matches[0].isDisabled())
    throw new CmsError(
      "action_unavailable",
      "CMS has disabled this action; check eligibility and required fields.",
    );
  await matches[0].evaluate((e) => (e as HTMLElement).click());
}
export async function inspectFields(scope: Locator): Promise<FormField[]> {
  const inspected = await scope.evaluate((root) => {
    const visible = (e: Element) => !!e.getClientRects().length;
    const clean = (s: string | null | undefined) =>
      (s || "").replace(/\s+/g, " ").trim();
    const nodes = [
      ...root.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("input,select,textarea,[contenteditable=true]"),
    ];
    const result: FormField[] = [];
    const seen = new Map<
      string,
      { element: Element; type: string; form: HTMLFormElement | null }
    >();
    const ambiguous: string[] = [];
    const included = (e: Element) => {
      const type = e.getAttribute("type") || e.tagName.toLowerCase();
      if (
        ["hidden", "password", "submit", "button"].includes(type) ||
        e.closest(".multiselect-container")
      )
        return false;
      const wrapper = e.closest("tt-input");
      if (type === "file") return visible(e.parentElement || e);
      return (
        visible(e) || (e.tagName === "SELECT" && !!wrapper && visible(wrapper))
      );
    };
    for (const e of nodes) {
      if (!included(e)) continue;
      const type = e.getAttribute("type") || e.tagName.toLowerCase();
      const wrapper = e.closest("tt-input");
      const group = e.closest(".form-group") || e.parentElement;
      const label = clean(
        wrapper?.getAttribute("label") ||
          e.getAttribute("aria-label") ||
          (e as HTMLInputElement).labels?.[0]?.textContent ||
          group?.querySelector("label")?.textContent ||
          e.getAttribute("placeholder"),
      );
      let id = e.getAttribute("name") || wrapper?.getAttribute("name") || "";
      if (!id && e.id && !/^(input-|fileUploaderInput_|cke_)/.test(e.id))
        id = e.id;
      if (!id) id = type === "file" ? "file" : label;
      const required =
        e.hasAttribute("required") ||
        e.getAttribute("aria-required") === "true" ||
        /\*\s*$/.test(label);
      if (!id) {
        if (required) ambiguous.push("unidentified required field");
        continue;
      }
      const owner = (e as HTMLInputElement).form || null;
      const prior = seen.get(id);
      if (prior) {
        // A single named radio group intentionally shares its field ID. Separate forms
        // or a colliding text/checkbox/select field must never be silently deduplicated.
        if (
          type === "radio" &&
          prior.type === "radio" &&
          e.getAttribute("name") === id &&
          prior.form === owner
        )
          continue;
        ambiguous.push(id);
        continue;
      }
      seen.set(id, { element: e, type, form: owner });
      const f: FormField = {
        id,
        label: label || id,
        type,
        required,
        read_only:
          e.hasAttribute("readonly") || (e as HTMLInputElement).disabled,
      };
      if (type === "radio") {
        const name = e.getAttribute("name");
        const radios = (
          name
            ? nodes.filter(
                (x) =>
                  included(x) &&
                  x.getAttribute("type") === "radio" &&
                  x.getAttribute("name") === name &&
                  (x as HTMLInputElement).form === owner,
              )
            : [e]
        ) as HTMLInputElement[];
        const values = radios.map((x) => x.value);
        if (new Set(values).size !== values.length) ambiguous.push(id);
        f.required =
          radios.some(
            (x) => x.required || x.getAttribute("aria-required") === "true",
          ) || required;
        f.read_only = radios.every((x) => x.disabled);
        f.options = radios.map((x) => ({
          value: x.value,
          label: clean(x.labels?.[0]?.textContent) || x.value,
          disabled: x.disabled,
        }));
        f.value = radios.find((x) => x.checked)?.value || "";
      } else if (type === "checkbox") f.value = (e as HTMLInputElement).checked;
      else if (e.tagName === "SELECT") {
        const select = e as HTMLSelectElement;
        f.type = select.multiple ? "multiselect" : "select";
        f.options = [...select.options].map((o) => ({
          value: o.value,
          label: clean(o.textContent),
          disabled:
            o.disabled ||
            (o.parentElement?.tagName === "OPTGROUP" &&
              (o.parentElement as HTMLOptGroupElement).disabled),
        }));
        f.value = select.multiple
          ? [...select.selectedOptions].map((o) => o.value)
          : select.value;
      } else if (type === "file") f.type = "file";
      else
        f.value =
          e.getAttribute("contenteditable") === "true"
            ? clean(e.textContent)
            : e.value;
      result.push(f);
    }
    for (const iframe of root.querySelectorAll<HTMLIFrameElement>(
      'iframe[title^="Editor"]',
    )) {
      if (!visible(iframe)) continue;
      const editorName = (iframe.getAttribute("title") || "Editor").replace(
        /^Editor,?\s*/,
        "",
      );
      const id = "editor:" + editorName;
      if (seen.has(id)) {
        ambiguous.push(id);
        continue;
      }
      seen.set(id, { element: iframe, type: "richtext", form: null });
      result.push({
        id,
        label: editorName,
        type: "richtext",
        required: false,
        value: iframe.contentDocument?.body?.innerText || "",
      });
    }
    return { fields: result, ambiguous };
  });
  if (inspected.ambiguous.length)
    throw new CmsError(
      "ambiguous_field",
      "CMS exposes duplicate or unidentified form fields. No field has been changed.",
      { fields: [...new Set(inspected.ambiguous)] },
    );
  return inspected.fields;
}
function attr(value: string) {
  return JSON.stringify(value);
}
async function unique(
  node: Locator,
  field: FormField,
): Promise<Locator | undefined> {
  const count = await node.count();
  if (count > 1)
    throw new CmsError(
      "ambiguous_field",
      "The form field matches multiple controls.",
      {
        field: field.id,
        count,
      },
    );
  return count === 1 ? node : undefined;
}
function namedControls(
  scope: Locator,
  attribute: "name" | "id",
  value: string,
): Locator {
  const match = "[" + attribute + "=" + attr(value) + "]";
  // Match actual controls, never a named tt-input wrapper. Bootstrap dropdowns
  // deliberately hide their native select inside a visible custom element.
  return scope.locator(
    "input" +
      match +
      ":not([type=hidden]):visible," +
      "select" +
      match +
      ":visible,tt-input:visible select" +
      match +
      "," +
      "textarea" +
      match +
      ":visible,[contenteditable=true]" +
      match +
      ":visible",
  );
}
export async function fieldLocator(
  scope: Locator,
  field: FormField,
): Promise<Locator> {
  if (field.type === "file") {
    const named = await unique(
      scope.locator("input[type=file][name=" + attr(field.id) + "]"),
      field,
    );
    if (named) return named;
    const identified = await unique(
      scope.locator("input[type=file][id=" + attr(field.id) + "]"),
      field,
    );
    if (identified) return identified;
    const wrapped = await unique(
      scope.locator(
        "tt-input[name=" + attr(field.id) + "]:visible input[type=file]",
      ),
      field,
    );
    if (wrapped) return wrapped;
    if (field.id === "file") {
      const onlyFile = await unique(scope.locator("input[type=file]"), field);
      if (onlyFile) return onlyFile;
    }
  } else {
    const named = await unique(namedControls(scope, "name", field.id), field);
    if (named) return named;
    const wrapped = await unique(
      scope
        .locator("tt-input[name=" + attr(field.id) + "]:visible")
        .locator(
          "select,input:not([type=hidden]):visible,textarea:visible,[contenteditable=true]:visible",
        ),
      field,
    );
    if (wrapped) return wrapped;
    const identified = await unique(
      namedControls(scope, "id", field.id),
      field,
    );
    if (identified) return identified;
    const labelled = await unique(
      scope.getByLabel(field.label, { exact: true }),
      field,
    );
    if (labelled) return labelled;
  }
  throw new CmsError(
    "page_changed",
    "The form field cannot be located unambiguously.",
    {
      field: field.id,
    },
  );
}
function validateValues(
  fields: FormField[],
  proposed: Record<string, FieldValue>,
  reserved: string[],
) {
  if (new Set(fields.map((f) => f.id)).size !== fields.length)
    throw new CmsError(
      "ambiguous_field",
      "The form contains duplicate field identifiers.",
    );
  for (const key of Object.keys(proposed)) {
    if (reserved.includes(key)) continue;
    const field = fields.find((f) => f.id === key);
    if (!field || field.read_only || field.type === "file")
      throw new CmsError(
        "invalid_field",
        "Choose editable fields returned by cms_get_form.",
        {
          field: key,
        },
      );
    const value = proposed[key];
    if (field.type === "checkbox" && typeof value !== "boolean")
      throw new CmsError(
        "invalid_field",
        "Checkbox fields require true or false.",
        { field: key },
      );
    if (field.options) {
      if (field.type !== "multiselect" && Array.isArray(value))
        throw new CmsError(
          "invalid_field",
          "This control accepts one choice.",
          { field: key },
        );
      for (const item of Array.isArray(value) ? value : [String(value)]) {
        const matches = field.options.filter(
          (o) => !o.disabled && (o.value === item || o.label === item),
        );
        if (matches.length !== 1)
          throw new CmsError(
            "invalid_choice",
            "Choose one unambiguous current CMS option.",
            {
              field: key,
            },
          );
      }
    } else if (Array.isArray(value))
      throw new CmsError(
        "invalid_field",
        "This control does not accept multiple values.",
        {
          field: key,
        },
      );
  }
}
export function validateFields(
  fields: FormField[],
  proposed: Record<string, FieldValue>,
  fileFields: string[],
  reserved: string[] = [],
) {
  validateValues(fields, proposed, reserved);
  for (const key of fileFields)
    if (!fields.some((f) => f.id === key && f.type === "file" && !f.read_only))
      throw new CmsError(
        "invalid_file_field",
        "Choose the editable file field returned by cms_get_form.",
        { field: key },
      );
  for (const field of fields) {
    if (!field.required || field.read_only) continue;
    const value = Object.hasOwn(proposed, field.id)
      ? proposed[field.id]
      : field.value;
    const missing =
      field.type === "file"
        ? !fileFields.includes(field.id)
        : field.type === "checkbox"
          ? value !== true
          : value === undefined ||
            value === "" ||
            (Array.isArray(value) && value.length === 0);
    if (missing)
      throw new CmsError(
        "required_field",
        "CMS requires a value before this change can be prepared.",
        { field: field.id, label: field.label },
      );
  }
}
export async function fillFields(
  scope: Locator,
  fields: FormField[],
  values: Record<string, FieldValue>,
  reserved: string[] = [],
) {
  // Resolve and validate the whole patch before the first edit: controls may
  // autosave on change or blur, so discovering ambiguity midway is too late.
  validateValues(fields, values, reserved);
  const resolved: { field: FormField; value: FieldValue; node: Locator }[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (reserved.includes(key)) continue;
    const field = fields.find((f) => f.id === key)!;
    let node: Locator;
    if (field.type === "richtext") {
      const name = key.slice("editor:".length),
        frames = scope.locator('iframe[title^="Editor"]');
      const matches: Locator[] = [];
      for (let i = 0; i < (await frames.count()); i++) {
        const frame = frames.nth(i);
        if (
          (await frame.isVisible()) &&
          (await frame.getAttribute("title"))?.replace(/^Editor,?\s*/, "") ===
            name
        )
          matches.push(frame);
      }
      if (matches.length !== 1)
        throw new CmsError(
          "page_changed",
          "CMS rich-text editor is missing or ambiguous.",
          {
            field: key,
          },
        );
      const handle = await matches[0].elementHandle(),
        frame = await handle?.contentFrame();
      if (!frame)
        throw new CmsError(
          "page_changed",
          "CMS rich-text editor is unavailable.",
        );
      node = frame.locator("body");
    } else if (field.type === "radio") {
      const option = field.options?.find(
        (o) =>
          !o.disabled &&
          (o.value === String(value) || o.label === String(value)),
      );
      if (!option)
        throw new CmsError(
          "invalid_choice",
          "Choose a current CMS radio option.",
          { field: key },
        );
      const radio =
        (await unique(
          scope.locator(
            "input[type=radio][name=" +
              attr(field.id) +
              "][value=" +
              attr(option.value) +
              "]",
          ),
          field,
        )) ||
        (await unique(
          scope.locator(
            "input[type=radio][id=" +
              attr(field.id) +
              "][value=" +
              attr(option.value) +
              "]",
          ),
          field,
        ));
      if (!radio)
        throw new CmsError(
          "page_changed",
          "CMS did not expose the approved radio choice.",
          {
            field: key,
          },
        );
      node = radio;
    } else {
      node = await fieldLocator(scope, field);
    }
    if (
      (await node.isDisabled()) ||
      (await node.getAttribute("readonly")) !== null
    )
      throw new CmsError(
        "invalid_field",
        "CMS no longer permits editing this field.",
        {
          field: key,
        },
      );
    resolved.push({ field, value, node });
  }
  for (const { field, value, node } of resolved) {
    if (field.type === "checkbox") {
      await node.setChecked(value as boolean);
      continue;
    }
    if (field.type === "radio") {
      await node.check();
      continue;
    }
    if (field.options) {
      const raw = (Array.isArray(value) ? value : [String(value)]).map(
        (v) =>
          field.options!.find(
            (o) => !o.disabled && (o.value === v || o.label === v),
          )!.value,
      );
      // Native selects hidden by CMS widgets still own the change handler.
      await node.selectOption(raw, { force: true });
      continue;
    }
    await node.fill(String(value));
    // Commit-only blur: some approved controls save as they lose focus.
    await node.evaluate((e) => (e as HTMLElement).blur());
  }
}

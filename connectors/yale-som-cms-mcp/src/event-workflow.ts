import { stat } from "node:fs/promises";
import { extname } from "node:path";

import type { Locator, Page } from "playwright-core";

import { inspectFields, validateFields } from "./forms.js";
import {
  CMS_ORIGIN,
  CmsError,
  type Change,
  type Effect,
  type FormField,
  type JsonRecord,
  type RecordEffect,
} from "./types.js";

export interface EventDocument {
  id: string;
  core_type: number;
  title: string;
  required: boolean;
  type: "upload" | "existing";
  name: string;
  existing_id: string;
  existing: { id: string; name: string }[];
  save_to_library: boolean;
  allowed_extensions: string[];
  max_bytes: number | null;
}
export interface EventWorkflow {
  event_id: string;
  slot_id: string | null;
  fields: FormField[];
  documents: EventDocument[];
  context: JsonRecord;
}
export interface EventSubmission {
  effects: Effect[];
  uploads: { document_type_id: string; uploaded_file_id: string }[];
}
const prefix = (id: string) => "document:" + id + ":";
const sourceMode = (value: unknown) =>
  value === "Existing"
    ? "existing"
    : value === "Upload New"
      ? "upload"
      : String(value);
const unsupported = (message: string) =>
  new CmsError("action_unavailable", message);

async function state(page: Page) {
  const data = await page.evaluate(() => {
    const roots = document.querySelectorAll("tt-edit-registration");
    if (roots.length !== 1)
      return {
        error: "CMS did not expose one native event registration form.",
      };
    const c = (window as any).angular
      ?.element(roots[0])
      .controller("ttEditRegistration");
    if (
      !c ||
      !c.isReady ||
      !c.event ||
      !Array.isArray(c.enabledStepIds) ||
      !Array.isArray(c.registrationDocuments)
    )
      return {
        error: "The native event registration controller is not ready.",
      };
    const str = (v: unknown) =>
      v === undefined || v === null ? "" : String(v);
    const steps = c.enabledStepIds;
    if (
      JSON.stringify(steps) !== '["docs","confirm"]' &&
      JSON.stringify(steps) !== '["confirm"]'
    )
      return {
        error:
          "This event requires an unreviewed step or survey. Complete it interactively in CMS.",
      };
    if (c.preSurveyMetadata || Object.keys(c.preSurveyResponse || {}).length)
      return {
        error:
          "This event includes survey metadata. Complete the survey interactively in CMS.",
      };
    if (
      c.docsStepId !== "docs" ||
      c.confirmationStepId !== "confirm" ||
      !Number.isInteger(c.stepIndex) ||
      c.stepIndex < 0 ||
      c.stepIndex >= steps.length
    )
      return { error: "The native event step layout has changed." };
    if (
      !c.isNew ||
      c.registrationId ||
      c.registration?.Id ||
      c.currentUser?.IsStudent !== true ||
      str(c.currentUser?.Id) !== str(c.studentId)
    )
      return {
        error:
          "Only a new registration for the signed-in student is supported.",
      };
    if (
      c.coreEventId ||
      c.coreScheduleId ||
      c.coreTimeSlotId ||
      c.coreScheduleTimeSlot
    )
      return {
        error:
          "Core-event reservation and slot-locking workflows require interactive registration.",
      };
    if (c.event.RegistrationInstructions)
      return {
        error:
          "This event requires external registration instructions. Complete them interactively in CMS.",
      };
    if (
      c.isTimeSlotExpired ||
      c.timeSlotRegistrationError ||
      c.isRegistrationBeingSubmitted
    )
      return {
        error:
          "This registration is expired, unavailable, or already being submitted.",
      };
    const rules = c.event.RegistrationRules;
    if (
      !rules ||
      (rules.CanRegister !== true && rules.CanRegisterForWaitlist !== true) ||
      rules.IsAttending === true ||
      rules.IsOnWaitlist === true
    )
      return { error: "CMS no longer permits this new event registration." };
    if (str(c.event.Id) !== str(c.eventId))
      return { error: "The event registration target is ambiguous." };
    const documents: EventDocument[] = [];
    for (const d of c.registrationDocuments) {
      const fs = d.fileService;
      if (
        !d ||
        !/^\d+$/.test(str(d.eventRegistrationDocumentTypeId)) ||
        ![1, 2, 3, 4, 5, 6].includes(d.registrationDocumentTypeCoreId) ||
        typeof d.displayTitle !== "string" ||
        typeof d.Name !== "string" ||
        typeof d.isRequired !== "boolean" ||
        (d.saveToApplicationMaterialsLibrary != null &&
          typeof d.saveToApplicationMaterialsLibrary !== "boolean") ||
        d.isNew !== true ||
        !["upload", "existing"].includes(d.type) ||
        !Array.isArray(d.existing) ||
        !!d.sendToTopResume ||
        !fs ||
        typeof fs.hasFiles !== "function" ||
        typeof fs.hasError !== "function" ||
        typeof fs.isUploading !== "boolean" ||
        !Array.isArray(fs.files)
      )
        return {
          error:
            "An event document uses an unreviewed layout, URL, current-document mode, or external consent.",
        };
      if (fs.isUploading || fs.hasFiles() || fs.hasError())
        return {
          error:
            "A document upload is already present or unfinished. Reconcile it before preparing another registration.",
        };
      const existing = d.existing.map((x: any) => ({
        id: str(x.Id),
        name: str(x.Name),
      }));
      if (
        existing.some((x: any) => !x.id || !x.name) ||
        new Set(existing.map((x: any) => x.id)).size !== existing.length ||
        new Set(existing.map((x: any) => x.name)).size !== existing.length
      )
        return {
          error: "Existing application documents have ambiguous identifiers.",
        };
      documents.push({
        id: str(d.eventRegistrationDocumentTypeId),
        core_type: d.registrationDocumentTypeCoreId,
        title: d.displayTitle,
        required: d.isRequired,
        type: d.type,
        name: str(d.Name),
        existing_id: str(d.ExistingApplicationDocumentId),
        existing,
        save_to_library: d.saveToApplicationMaterialsLibrary === true,
        allowed_extensions: Array.isArray(fs.AllowedExtensions)
          ? fs.AllowedExtensions.map(String)
          : [],
        max_bytes:
          typeof fs.attachmentSizeLimitInBytes === "number"
            ? fs.attachmentSizeLimitInBytes
            : null,
      });
    }
    if (
      new Set(documents.map((d) => d.id)).size !== documents.length ||
      (!steps.includes("docs") && documents.length)
    )
      return { error: "Event document requirements are ambiguous." };
    return {
      event_id: str(c.eventId),
      slot_id: str(c.timeSlotId) || null,
      step_index: c.stepIndex,
      steps: [...steps],
      documents,
      rules: {
        can_register: rules.CanRegister === true,
        can_waitlist: rules.CanRegisterForWaitlist === true,
        registration_begin: str(c.event.RegistrationBeginDate),
        registration_end: str(c.event.RegistrationEndDate),
      },
    };
  });
  if (data.error) throw unsupported(data.error);
  const route = new URL(page.url());
  const match = route.hash.match(
    /^#\/events\/(\d+)\/registration(?:\?([^#]*))?$/,
  );
  const params = new URLSearchParams(match?.[2]);
  if (
    route.origin !== CMS_ORIGIN ||
    !match ||
    match[1] !== data.event_id ||
    [...params.keys()].some((key) => key !== "timeSlotId") ||
    params.getAll("timeSlotId").length > 1 ||
    (params.get("timeSlotId") || null) !== data.slot_id
  )
    throw unsupported(
      "The native registration route does not match its exact event and time slot.",
    );
  return data as Required<Omit<typeof data, "error">>;
}

/** The observed method changes only the local step index. Never call unknown navigation code. */
async function goToStep(page: Page, index: number) {
  const result = await page.evaluate((index) => {
    const el = document.querySelector("tt-edit-registration");
    const ng = (window as any).angular;
    const c = el && ng?.element(el).controller("ttEditRegistration");
    const source = c?.goToStep?.toString().replace(/\s+/g, "");
    const pure =
      /^function\(([A-Za-z_$][\w$]*)\)\{this\.stepIndex=\1;?\}$/.test(
        source || "",
      );
    const scope = el && ng?.element(el).isolateScope();
    if (
      !pure ||
      !scope?.$apply ||
      scope.$root?.$$phase ||
      !Number.isInteger(index) ||
      !c.enabledStepIds[index]
    )
      return false;
    scope.$apply(() => c.goToStep(index));
    return c.stepIndex === index && c.currentStepId === c.enabledStepIds[index];
  }, index);
  if (!result)
    throw unsupported(
      "CMS step navigation no longer matches its reviewed local-only behavior.",
    );
}
async function documentScope(page: Page, id: string): Promise<Locator> {
  const nodes = page.locator("tt-edit-registration .registration-file");
  const indexes: number[] = [];
  for (let i = 0; i < (await nodes.count()); i++) {
    if (
      await nodes.nth(i).evaluate((el, id) => {
        const requirement = (window as any).angular
          ?.element(el)
          .scope()?.requirement;
        return String(requirement?.eventRegistrationDocumentTypeId) === id;
      }, id)
    )
      indexes.push(i);
  }
  if (indexes.length !== 1)
    throw unsupported(
      "CMS did not expose one exact event document requirement.",
    );
  return nodes.nth(indexes[0]);
}
async function one(scope: Locator, selector: string): Promise<Locator> {
  const node = scope.locator(selector);
  if ((await node.count()) !== 1)
    throw unsupported("An event registration control is missing or ambiguous.");
  return node;
}
const selectors = {
  name: 'input[id="documentName"][ng-model="model.Name"]',
  library:
    'input[name="saveToApplicationMaterialsLibrary"][data-ng-model="model.saveToApplicationMaterialsLibrary"]',
  existing: 'select[ng-model="model.ExistingApplicationDocumentId"]',
  file: 'input[type="file"][uploader="service"]',
};
async function inspectDocumentControls(page: Page, docs: EventDocument[]) {
  if (
    (await page.locator("tt-edit-registration .registration-file").count()) !==
    docs.length
  )
    throw unsupported(
      "The event document requirements no longer match their form controls.",
    );
  for (const d of docs) {
    const scope = await documentScope(page, d.id);
    const matches = await scope.evaluate((el, d) => {
      const c = (window as any).angular
        .element(document.querySelector("tt-edit-registration"))
        .controller("ttEditRegistration");
      const requirement = (window as any).angular
        .element(el)
        .scope().requirement;
      const clean = (x: string) => x.replace(/\s+/g, " ").trim();
      return (
        c.registrationDocuments.filter(
          (x: any) => String(x.eventRegistrationDocumentTypeId) === d.id,
        ).length === 1 &&
        c.registrationDocuments.includes(requirement) &&
        el.getAttribute("ng-repeat") ===
          "requirement in $ctrl.registrationDocuments" &&
        clean(el.querySelector("h4")?.textContent || "") ===
          clean(d.title + (d.required ? " (required)" : " (optional)"))
      );
    }, d);
    if (!matches)
      throw unsupported(
        "The event document heading does not match its exact requirement metadata.",
      );
    for (const selector of Object.values(selectors)) await one(scope, selector);
    const radios = scope.locator(
      'input[type=radio][name="uploadType"][data-ng-model="model.type"]',
    );
    const values = await radios.evaluateAll((es) =>
      es.map((e) => (e as HTMLInputElement).value).sort(),
    );
    if (JSON.stringify(values) !== '["current","existing","upload"]')
      throw unsupported("The event document source choices have changed.");
    const controls = await scope
      .locator("input,select,textarea,[contenteditable=true]")
      .count();
    if (controls !== 7)
      throw unsupported("The event document includes an unreviewed field.");
  }
}
async function finalControl(page: Page) {
  const scope = page.locator("tt-edit-registration");
  if ((await inspectFields(scope)).length)
    throw unsupported(
      "The event confirmation includes unreviewed fields or consent.",
    );
  const node = await one(scope, '[tt-click="$ctrl.save()"]');
  if (
    !(await node.isVisible()) ||
    !/^(Register|Join Waitlist)$/i.test((await node.innerText()).trim())
  )
    throw unsupported(
      "CMS did not expose the reviewed event registration confirmation.",
    );
  return node;
}
export async function inspectEventWorkflow(page: Page): Promise<EventWorkflow> {
  const current = await state(page);
  const fields: FormField[] = [];
  try {
    if (current.steps.includes("docs")) {
      await goToStep(page, current.steps.indexOf("docs"));
      await inspectDocumentControls(page, current.documents);
      for (const d of current.documents) {
        const p = prefix(d.id);
        fields.push({
          id: p + "type",
          label: d.title + ": source",
          type: "select",
          required: true,
          value: d.type,
          options: [
            { value: "upload", label: "Upload New" },
            ...(d.existing.length
              ? [{ value: "existing", label: "Existing" }]
              : []),
          ],
        });
        fields.push({
          id: p + "name",
          label: d.title + ": document name",
          type: "text",
          required: false,
          value: d.name,
        });
        fields.push({
          id: p + "save_to_library",
          label: d.title + ": save to application materials library",
          type: "checkbox",
          required: false,
          value: d.save_to_library,
        });
        fields.push({
          id: p + "file",
          label:
            d.title + ": file (required when uploading this required document)",
          type: "file",
          required: false,
        });
        if (d.existing.length)
          fields.push({
            id: p + "existing",
            label: d.title + ": existing document",
            type: "select",
            required: false,
            value: d.existing_id,
            options: d.existing.map((x) => ({ value: x.id, label: x.name })),
          });
      }
    }
    await goToStep(page, current.steps.indexOf("confirm"));
    await finalControl(page);
    const text = await page
      .locator(
        'tt-edit-registration [ng-if="$ctrl.currentStepId == $ctrl.confirmationStepId"]',
      )
      .innerText();
    return {
      event_id: current.event_id,
      slot_id: current.slot_id,
      fields,
      documents: current.documents,
      context: {
        workflow: "native_event_registration",
        steps: current.steps,
        registration_rules: current.rules,
        document_requirements: current.documents,
        confirmation: text.replace(/\s+/g, " ").trim(),
        effects: [
          "Upload each selected local file immediately",
          "Save explicitly selected documents to the application materials library when registering",
          "Submit the exact event and time slot once",
        ],
      },
    };
  } finally {
    await goToStep(page, current.step_index);
  }
}

export function validateEventWorkflow(workflow: EventWorkflow, change: Change) {
  if (
    change.operation !== "event_register" ||
    change.area !== "events" ||
    change.target_id !== workflow.event_id ||
    (change.slot_id || null) !== workflow.slot_id
  )
    throw new CmsError(
      "record_changed",
      "The event or time slot no longer matches this registration.",
    );
  validateFields(
    workflow.fields,
    change.fields,
    change.files.map((f) => f.field),
  );
  if (new Set(change.files.map((f) => f.field)).size !== change.files.length)
    throw new CmsError(
      "invalid_file_field",
      "Choose only one local file for each event document requirement.",
    );
  for (const d of workflow.documents) {
    const p = prefix(d.id),
      mode = sourceMode(change.fields[p + "type"] ?? d.type);
    const file = change.files.find((f) => f.field === p + "file");
    const name = String(change.fields[p + "name"] ?? d.name).trim();
    const selected = String(change.fields[p + "existing"] ?? d.existing_id);
    if (mode === "existing") {
      if (
        file ||
        Object.hasOwn(change.fields, p + "name") ||
        Object.hasOwn(change.fields, p + "save_to_library")
      )
        throw new CmsError(
          "invalid_field",
          "Existing document selection cannot also upload, rename, or save another library copy.",
        );
      if (!d.existing.some((x) => x.id === selected || x.name === selected))
        throw new CmsError(
          "required_field",
          "Choose the exact existing document for this requirement.",
          { field: p + "existing" },
        );
    } else if (mode === "upload") {
      if (Object.hasOwn(change.fields, p + "existing"))
        throw new CmsError(
          "invalid_field",
          "An upload cannot also select an existing document.",
        );
      if (
        (d.required ||
          Object.hasOwn(change.fields, p + "name") ||
          (change.fields[p + "save_to_library"] ?? d.save_to_library) ===
            true) &&
        !file
      )
        throw new CmsError(
          "required_file",
          "Choose a local file for this event document requirement.",
          { field: p + "file" },
        );
      if (
        file &&
        d.allowed_extensions.length &&
        !d.allowed_extensions.some(
          (extension) =>
            "." + extension.replace(/^\\./, "").toLowerCase() ===
            extname(file.path).toLowerCase(),
        )
      )
        throw new CmsError(
          "invalid_file",
          "This file extension is not permitted by the event document uploader.",
          { field: p + "file", allowed_extensions: d.allowed_extensions },
        );
      if (file && !name)
        throw new CmsError(
          "required_field",
          "Give the uploaded event document a name.",
          {
            field: p + "name",
          },
        );
    } else
      throw new CmsError(
        "invalid_choice",
        "Choose an observed event document source.",
      );
  }
}

export async function fillEventWorkflow(
  page: Page,
  change: Change,
  recordEffect: RecordEffect,
): Promise<EventSubmission> {
  const workflow = await inspectEventWorkflow(page);
  validateEventWorkflow(workflow, change);
  for (const file of change.files) {
    const d = workflow.documents.find(
      (d) => file.field === prefix(d.id) + "file",
    )!;
    const info = await stat(file.path);
    if (!info.isFile() || (d.max_bytes !== null && info.size > d.max_bytes))
      throw new CmsError(
        "invalid_file",
        "The local file exceeds this event document uploader's limits.",
        { field: file.field, max_bytes: d.max_bytes },
      );
  }
  const effects: Effect[] = [],
    uploads: EventSubmission["uploads"] = [];
  const intend = async (name: string, details?: JsonRecord) => {
    const effect: Effect = {
      name,
      status: "intended",
      target: change.target_id,
      ...(details ? { details } : {}),
    };
    await recordEffect(effect);
    effects.push(effect);
    return effect;
  };
  const verified = async (effect: Effect, details?: JsonRecord) => {
    effect.status = "verified";
    if (details) effect.details = { ...effect.details, ...details };
    await recordEffect(effect);
  };
  if ((workflow.context.steps as string[]).includes("docs")) {
    await goToStep(page, 0);
    await inspectDocumentControls(page, workflow.documents);
    for (const d of workflow.documents) {
      const p = prefix(d.id),
        scope = await documentScope(page, d.id);
      const mode = sourceMode(change.fields[p + "type"] ?? d.type);
      const file = change.files.find((f) => f.field === p + "file");
      const proposed = Object.keys(change.fields).filter((key) =>
        key.startsWith(p),
      );
      if (proposed.length) {
        const effect = await intend("event_document_fields:" + d.id);
        const radio = await one(
          scope,
          'input[type=radio][name="uploadType"][value="' + mode + '"]',
        );
        await radio.check();
        if (mode === "existing") {
          const requested = String(
            change.fields[p + "existing"] ?? d.existing_id,
          );
          const selected = d.existing.filter(
            (x) => x.id === requested || x.name === requested,
          );
          if (selected.length !== 1)
            throw new CmsError(
              "invalid_choice",
              "The existing event document is ambiguous.",
            );
          const select = await one(scope, selectors.existing);
          const matches = await select
            .locator("option")
            .evaluateAll(
              (options, name) =>
                options
                  .filter((o) => o.textContent?.trim() === name)
                  .map((o) => (o as HTMLOptionElement).value),
              selected[0].name,
            );
          if (matches.length !== 1)
            throw new CmsError(
              "ambiguous_field",
              "The native existing-document options are ambiguous.",
            );
          await select.selectOption(matches[0]);
        } else {
          if (Object.hasOwn(change.fields, p + "name"))
            await (
              await one(scope, selectors.name)
            ).fill(String(change.fields[p + "name"]));
          if (Object.hasOwn(change.fields, p + "save_to_library"))
            await (
              await one(scope, selectors.library)
            ).setChecked(change.fields[p + "save_to_library"] as boolean);
        }
        const matches = await scope.evaluate(
          (el, input) => {
            const d = (window as any).angular.element(el).scope().requirement;
            return (
              d.type === input.mode &&
              !d.sendToTopResume &&
              (input.name === undefined || d.Name === input.name) &&
              (input.library === undefined ||
                d.saveToApplicationMaterialsLibrary === input.library) &&
              (input.existing === undefined ||
                String(d.ExistingApplicationDocumentId) === input.existing)
            );
          },
          {
            mode,
            name: mode === "upload" ? change.fields[p + "name"] : undefined,
            library:
              mode === "upload"
                ? change.fields[p + "save_to_library"]
                : undefined,
            existing:
              mode === "existing"
                ? d.existing.find(
                    (x) =>
                      x.id ===
                        String(
                          change.fields[p + "existing"] ?? d.existing_id,
                        ) ||
                      x.name ===
                        String(change.fields[p + "existing"] ?? d.existing_id),
                  )?.id
                : undefined,
          },
        );
        if (!matches)
          throw new CmsError(
            "record_changed",
            "CMS did not retain the exact approved event document fields.",
          );
        await verified(effect);
      }
      if (file) {
        const effect = await intend("event_document_upload:" + d.id, {
          document_type_id: d.id,
        });
        await (await one(scope, selectors.file)).setInputFiles(file.path);
        try {
          await page.waitForFunction(
            (id) => {
              const c = (window as any).angular
                ?.element(document.querySelector("tt-edit-registration"))
                .controller("ttEditRegistration");
              const d = c?.registrationDocuments?.find(
                (d: any) => String(d.eventRegistrationDocumentTypeId) === id,
              );
              const fs = d?.fileService;
              return (
                !fs ||
                fs.hasError() ||
                (!fs.isUploading &&
                  fs.hasFiles() &&
                  fs.files.length === 1 &&
                  !!fs.files[0]?.FileId)
              );
            },
            d.id,
            { timeout: 60000 },
          );
        } catch {
          throw new CmsError(
            "upload_uncertain",
            "The event document upload did not reach an acknowledged ready state.",
          );
        }
        const fileId = await scope.evaluate((el) => {
          const d = (window as any).angular.element(el).scope().requirement,
            fs = d.fileService;
          return !fs.isUploading &&
            !fs.hasError() &&
            fs.hasFiles() &&
            fs.files.length === 1 &&
            fs.files[0]?.FileId
            ? String(fs.files[0].FileId)
            : null;
        });
        if (!fileId)
          throw new CmsError(
            "upload_uncertain",
            "CMS did not acknowledge the exact event document upload.",
          );
        uploads.push({ document_type_id: d.id, uploaded_file_id: fileId });
        await verified(effect, { uploaded_file_id: fileId });
      }
    }
    const next = await one(
      page.locator("tt-edit-registration"),
      '[ng-click="$ctrl.continue()"]',
    );
    const pure = await next.evaluate((el) => {
      const c = (window as any).angular
        .element(document.querySelector("tt-edit-registration"))
        .controller("ttEditRegistration");
      return /^function\(\)\{this\.stepIndex\+\+;this\.stepIndex>=this\.enabledStepIds\.length&&\(this\.stepIndex=this\.enabledStepIds\.length-1\);?\}$/.test(
        c.continue.toString().replace(/\s+/g, ""),
      );
    });
    if (
      !pure ||
      (await next.isDisabled()) ||
      (await next.getAttribute("disabled")) !== null
    )
      throw new CmsError(
        "required_field",
        "CMS has not accepted all event documents for continuation.",
      );
    await next.evaluate((e) => (e as HTMLElement).click());
  } else await goToStep(page, 0);
  const final = await finalControl(page);
  if (
    (await final.isDisabled()) ||
    (await final.getAttribute("disabled")) !== null
  )
    throw new CmsError(
      "action_unavailable",
      "CMS has disabled this event registration.",
    );
  const expected = {
    event_id: workflow.event_id,
    slot_id: workflow.slot_id,
    steps: workflow.context.steps,
    documents: workflow.documents.map((d) => {
      const p = prefix(d.id),
        mode = sourceMode(change.fields[p + "type"] ?? d.type);
      const wanted = String(change.fields[p + "existing"] ?? d.existing_id);
      return {
        id: d.id,
        title: d.title,
        required: d.required,
        core_type: d.core_type,
        mode,
        name: String(change.fields[p + "name"] ?? d.name),
        library:
          (change.fields[p + "save_to_library"] ?? d.save_to_library) === true,
        existing:
          d.existing.find((x) => x.id === wanted || x.name === wanted)?.id ||
          "",
        file_id:
          uploads.find((x) => x.document_type_id === d.id)?.uploaded_file_id ||
          "",
      };
    }),
  };
  const checkFinal = async (submit: boolean) =>
    page.evaluate(
      ({ expected, submit }) => {
        const host = document.querySelector("tt-edit-registration");
        const c = (window as any).angular
          ?.element(host)
          .controller("ttEditRegistration");
        const str = (v: unknown) =>
          v === undefined || v === null ? "" : String(v);
        const rules = c?.event?.RegistrationRules;
        if (
          !c ||
          str(c.eventId) !== expected.event_id ||
          str(c.event?.Id) !== expected.event_id ||
          (str(c.timeSlotId) || null) !== expected.slot_id ||
          c.currentStepId !== "confirm" ||
          !c.isNew ||
          c.isRegistrationBeingSubmitted ||
          c.isTimeSlotExpired ||
          c.timeSlotRegistrationError ||
          JSON.stringify(c.enabledStepIds) !== JSON.stringify(expected.steps) ||
          c.event.RegistrationInstructions ||
          c.preSurveyMetadata ||
          Object.keys(c.preSurveyResponse || {}).length ||
          c.coreEventId ||
          c.coreScheduleId ||
          c.coreTimeSlotId ||
          c.currentUser?.IsStudent !== true ||
          str(c.studentId) !== str(c.currentUser.Id) ||
          !rules ||
          (rules.CanRegister !== true &&
            rules.CanRegisterForWaitlist !== true) ||
          rules.IsAttending ||
          rules.IsOnWaitlist ||
          c.event.IsAttending === true ||
          c.registrationDocuments.length !== expected.documents.length
        )
          return false;
        for (const wanted of expected.documents) {
          const matches = c.registrationDocuments.filter(
            (d: any) => str(d.eventRegistrationDocumentTypeId) === wanted.id,
          );
          if (matches.length !== 1) return false;
          const d = matches[0],
            fs = d.fileService;
          if (
            d.displayTitle !== wanted.title ||
            d.isRequired !== wanted.required ||
            d.registrationDocumentTypeCoreId !== wanted.core_type ||
            d.type !== wanted.mode ||
            !!d.sendToTopResume ||
            !fs ||
            fs.isUploading ||
            fs.hasError()
          )
            return false;
          if (wanted.mode === "existing") {
            if (
              !wanted.existing ||
              str(d.ExistingApplicationDocumentId) !== wanted.existing ||
              fs.hasFiles()
            )
              return false;
          } else {
            if (
              str(d.Name) !== wanted.name ||
              (d.saveToApplicationMaterialsLibrary === true) !== wanted.library
            )
              return false;
            if (
              wanted.file_id
                ? !fs.hasFiles() ||
                  fs.files.length !== 1 ||
                  str(fs.files[0].FileId) !== wanted.file_id
                : fs.hasFiles() || wanted.required
            )
              return false;
          }
        }
        const controls = host!.querySelectorAll<HTMLElement>(
          '[tt-click="$ctrl.save()"]',
        );
        if (
          controls.length !== 1 ||
          !controls[0].getClientRects().length ||
          controls[0].hasAttribute("disabled") ||
          controls[0].getAttribute("aria-disabled") === "true"
        )
          return false;
        if (submit) controls[0].click();
        return true;
      },
      { expected, submit },
    );
  if (!(await checkFinal(false)))
    throw new CmsError(
      "record_changed",
      "The exact event registration or document state changed before submission.",
    );
  for (const d of workflow.documents) {
    const p = prefix(d.id);
    if (
      sourceMode(change.fields[p + "type"] ?? d.type) !== "existing" &&
      (change.fields[p + "save_to_library"] ?? d.save_to_library) === true
    )
      await intend("event_document_library:" + d.id, {
        document_type_id: d.id,
      });
  }
  await intend("event_register", {
    event_id: workflow.event_id,
    slot_id: workflow.slot_id,
    uploads,
  });
  if (!(await checkFinal(true)))
    throw new CmsError(
      "record_changed",
      "CMS changed the exact registration state after journaling; submission was not retried.",
    );
  // The caller must verify the signed-in student's exact event/slot registration.
  // Library effects require independent library evidence; never mark them from a toast.
  return { effects, uploads };
}

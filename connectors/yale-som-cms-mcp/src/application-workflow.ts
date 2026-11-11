import { stat } from "node:fs/promises";
import { extname } from "node:path";

import type { Locator, Page } from "playwright-core";

import { validateFields } from "./forms.js";
import {
  CMS_ORIGIN,
  CmsError,
  type Change,
  type Effect,
  type FormField,
  type JsonRecord,
  type RecordEffect,
} from "./types.js";

export interface ApplicationDocument {
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
export interface ApplicationWorkflow {
  posting_id: string;
  applicant_id: string;
  fields: FormField[];
  documents: ApplicationDocument[];
  context: JsonRecord;
}
export interface ApplicationSubmission {
  effects: Effect[];
  uploads: { document_type_id: string; uploaded_file_id: string }[];
}
const prefix = (id: string) => "document:" + id + ":";
const modeOf = (value: unknown) =>
  value === "Upload New" ? "upload" : value === "Existing" ? "existing" : String(value);
const unavailable = (reason: string) => new CmsError("action_unavailable", reason);
const wrapperSelector = 'tt-jp-apply [ng-repeat="requirement in $ctrl.applicationFiles"]';
const finalSelector =
  'tt-jp-apply [tt-click="$ctrl.needConfirmationPage ? $ctrl.continue() : $ctrl.apply()"]';
const controls = {
  name: 'input[id="documentName"][ng-model="model.Name"]',
  library:
    'input[name="saveToApplicationMaterialsLibrary"][data-ng-model="model.saveToApplicationMaterialsLibrary"]',
  file: 'input[type=file][uploader="service"]',
  existing: 'select[ng-model="model.ExistingApplicationDocumentId"]',
};

async function snapshot(page: Page, allowUploads = false) {
  const result = await page.evaluate((allowUploads) => {
    const hosts = document.querySelectorAll("tt-jp-apply");
    if (hosts.length !== 1) return { error: "CMS did not expose one native application form." };
    const ng = (window as any).angular;
    const c = ng?.element(hosts[0]).controller("ttJpApply");
    if (!c?.jobPosting || !Array.isArray(c.applicationFiles) || !c.currentUser || !c.application)
      return { error: "The native application controller is not ready." };
    const j = c.jobPosting,
      str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
    const session = (window as any).TT?.CurrentSession?.CurrentUser;
    if (
      j.ShouldApplyViaSite !== true ||
      j.ShouldApplyExternally ||
      j.ShouldApplyViaEmail ||
      j.ShouldApplyViaFax ||
      j.ShouldApplyViaMail ||
      c.needConfirmationPage ||
      c.isConfirmationStep
    ) {
      return {
        external: true,
        error:
          "This posting requires an external application. Complete it at the employer's destination; CMS Mark as Applied is not an application submission.",
        handoff: {
          url: str(j.Url) || null,
          email: str(j.ApplicationEmailAddress) || null,
          fax: str(j.ApplicationFaxNumber) || null,
          address: str(j.ApplicationAddress) || null,
        },
      };
    }
    if (
      str(c.postingId) !== str(j.Id) ||
      c.currentUser.IsStudent !== true ||
      c.currentUser.IsAdministrator ||
      !session ||
      str(session.Id) !== str(c.currentUser.Id) ||
      session.TypeId !== 2 ||
      (window as any).TT?.Types?.UserType?.Student !== 2 ||
      str(c.applicantId) !== str(c.currentUser.Id) ||
      str(c.application.ApplicantId) !== str(c.currentUser.Id) ||
      Number(c.application.Id) !== 0 ||
      (j.CurrentUserApplication && Number(j.CurrentUserApplication.Id) !== 0)
    )
      return { error: "Only a new application for the signed-in student is supported." };
    if (j.Rules?.CanApply !== true || j.Rules.HasApplied || j.Rules.IsEligibleToApply === false)
      return { error: "CMS no longer permits this exact application." };
    if (
      c.isDocsStep !== true ||
      c.step !== c.docsStepId ||
      c.hasMultipleLocations ||
      (c.rankedLocations?.length || 0) > 0 ||
      j.Rules.CanBid ||
      c.allowApprovedResumesOnly ||
      (c.pointsToBid !== undefined && c.pointsToBid !== null)
    )
      return {
        error:
          "This application requires an unreviewed step, office ranking, bidding, or approved-document workflow.",
      };
    if (
      !c.entity ||
      !c.entity.CustomAttributeValues ||
      Object.keys(c.entity.CustomAttributeValues).length ||
      Object.keys(c.application.CustomAttributeValues || {}).length
    )
      return { error: "Applications with custom questions require interactive completion." };
    const groups = [...hosts[0].querySelectorAll("tt-attribute-input-collection")];
    if (groups.length !== 1) return { error: "The application question layout has changed." };
    const questions = ng.element(groups[0]).controller("ttAttributeInputCollection");
    if (
      !Array.isArray(questions?.attributeGroups) ||
      questions.attributeGroups.length ||
      !Array.isArray(questions.revealedFieldNames) ||
      questions.revealedFieldNames.length ||
      groups[0].querySelector("input,select,textarea,[contenteditable=true],iframe")
    )
      return { error: "Applications with custom questions require interactive completion." };
    const documents: ApplicationDocument[] = [],
      ready: { id: string; file_ids: string[] }[] = [];
    for (const d of c.applicationFiles) {
      const fs = d?.fileService;
      if (
        !d ||
        !/^\d+$/.test(str(d.jobApplicationDocumentTypeId)) ||
        ![1, 2, 3, 4, 5, 6].includes(d.jobCoreApplicationDocumentTypeId) ||
        typeof d.displayTitle !== "string" ||
        typeof d.Name !== "string" ||
        typeof d.isRequired !== "boolean" ||
        d.isNew !== true ||
        !["upload", "existing"].includes(d.type) ||
        !!d.sendToTopResume ||
        (d.saveToApplicationMaterialsLibrary != null &&
          typeof d.saveToApplicationMaterialsLibrary !== "boolean") ||
        !Array.isArray(d.existing) ||
        !fs ||
        typeof fs.hasFiles !== "function" ||
        typeof fs.hasError !== "function" ||
        typeof fs.isUploading !== "boolean" ||
        !Array.isArray(fs.files)
      )
        return {
          error:
            "An application document uses an unreviewed layout, URL, current-document mode, or external consent.",
        };
      if (fs.isUploading || fs.hasError() || (!allowUploads && fs.hasFiles()))
        return {
          error:
            "An application upload is already present or unfinished. Reconcile it before another application.",
        };
      const existing = d.existing.map((x: any) => ({ id: str(x.Id), name: str(x.Name) }));
      if (
        existing.some((x: any) => !x.id || !x.name) ||
        new Set(existing.map((x: any) => x.id)).size !== existing.length ||
        new Set(existing.map((x: any) => x.name)).size !== existing.length
      )
        return { error: "Existing application documents have ambiguous identifiers or names." };
      documents.push({
        id: str(d.jobApplicationDocumentTypeId),
        core_type: d.jobCoreApplicationDocumentTypeId,
        title: d.displayTitle,
        required: d.isRequired,
        type: d.type,
        name: d.Name,
        existing_id: str(d.ExistingApplicationDocumentId),
        existing,
        save_to_library: d.saveToApplicationMaterialsLibrary === true,
        allowed_extensions: Array.isArray(fs.AllowedExtensions)
          ? fs.AllowedExtensions.map(String)
          : [],
        max_bytes:
          typeof fs.attachmentSizeLimitInBytes === "number" ? fs.attachmentSizeLimitInBytes : null,
      });
      ready.push({
        id: str(d.jobApplicationDocumentTypeId),
        file_ids: fs.files.map((x: any) => str(x.FileId)),
      });
    }
    if (new Set(documents.map((d) => d.id)).size !== documents.length)
      return { error: "Application document requirements have duplicate IDs." };
    return {
      posting_id: str(j.Id),
      applicant_id: str(c.applicantId),
      documents,
      ready,
      rules: {
        can_apply: j.Rules.CanApply,
        has_applied: j.Rules.HasApplied === true,
        is_eligible: j.Rules.IsEligibleToApply !== false,
        start: str(j.ApplicationStartDate),
        deadline: str(j.ApplicationDeadlineDate),
      },
    };
  }, allowUploads);
  if (result.error) {
    if (result.external) throw new CmsError("external_application", result.error, result.handoff);
    throw unavailable(result.error);
  }
  const url = new URL(page.url()),
    route = url.hash.match(/^#\/jobPostings\/(\d+)\/application(?:\?([^#]*))?$/);
  const params = new URLSearchParams(route?.[2]);
  if (
    url.origin !== CMS_ORIGIN ||
    !route ||
    route[1] !== result.posting_id ||
    [...params.keys()].some((key) => !["r", "p"].includes(key)) ||
    [...params.keys()].some((key) => params.getAll(key).length !== 1) ||
    [...params.values()].some((value) => !["", "true", "false"].includes(value))
  )
    throw unavailable(
      "The native application route does not match its exact posting or reviewed analytics options.",
    );
  return result as Required<Omit<typeof result, "error" | "external" | "handoff">>;
}
async function only(scope: Locator, selector: string) {
  const node = scope.locator(selector);
  if ((await node.count()) !== 1)
    throw unavailable("An application control is missing or ambiguous.");
  return node;
}
async function documentScope(page: Page, id: string) {
  const nodes = page.locator(wrapperSelector),
    matches: number[] = [];
  for (let i = 0; i < (await nodes.count()); i++)
    if (
      await nodes
        .nth(i)
        .evaluate(
          (el, id) =>
            String(
              (window as any).angular.element(el).scope()?.requirement
                ?.jobApplicationDocumentTypeId,
            ) === id,
          id,
        )
    )
      matches.push(i);
  if (matches.length !== 1)
    throw unavailable("CMS did not expose the exact application document requirement.");
  const matched = nodes.nth(matches[0]);
  await matched.evaluate((el, id) => el.setAttribute("data-laplace-application-document", id), id);
  return page.locator('tt-jp-apply [data-laplace-application-document="' + id + '"]');
}
async function assertRequirement(scope: Locator, id: string) {
  if (
    (await scope.count()) !== 1 ||
    !(await scope.evaluate((el, id) => {
      const ng = (window as any).angular,
        c = ng?.element(document.querySelector("tt-jp-apply")).controller("ttJpApply");
      const d = ng?.element(el).scope()?.requirement;
      return String(d?.jobApplicationDocumentTypeId) === id && c?.applicationFiles?.includes(d);
    }, id))
  )
    throw new CmsError(
      "record_changed",
      "The exact application document requirement changed before editing.",
    );
}
async function inspectControls(page: Page, documents: ApplicationDocument[]) {
  if ((await page.locator(wrapperSelector).count()) !== documents.length)
    throw unavailable("Application document controls no longer match the requirements.");
  for (const d of documents) {
    const scope = await documentScope(page, d.id);
    if (
      !(await scope.evaluate((el, d) => {
        const c = (window as any).angular
          .element(document.querySelector("tt-jp-apply"))
          .controller("ttJpApply");
        const model = (window as any).angular.element(el).scope().requirement;
        return (
          c.applicationFiles.includes(model) &&
          (el.querySelector("h4")?.textContent || "").replace(/\s+/g, " ").trim() ===
            (d.title + (d.required ? " (required)" : " (optional)")).replace(/\s+/g, " ").trim()
        );
      }, d))
    )
      throw unavailable(
        "The application document heading does not match its requirement metadata.",
      );
    for (const [kind, selector] of Object.entries(controls)) {
      if (kind === "existing" && !d.existing.length) {
        if (await scope.locator(selector).count())
          throw unavailable("Unexpected existing-document control.");
      } else await only(scope, selector);
    }
    const radios = await scope
      .locator('input[type=radio][name="uploadType"][data-ng-model="model.type"]')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLInputElement).value).sort());
    if (
      JSON.stringify(radios) !== '["current","existing","upload"]' ||
      (await scope.locator("input,select,textarea,[contenteditable=true]").count()) !==
        (d.existing.length ? 7 : 6)
    )
      throw unavailable("The application document contains unreviewed controls.");
  }
  const unexpected = await page
    .locator("tt-jp-apply")
    .evaluate((el) =>
      [...el.querySelectorAll("input,select,textarea,[contenteditable=true],iframe")].some(
        (e) => !e.closest('[ng-repeat="requirement in $ctrl.applicationFiles"]'),
      ),
    );
  if (unexpected) throw unavailable("The application contains additional unreviewed fields.");
  const final = page.locator(finalSelector);
  if (
    (await final.count()) !== 1 ||
    !(await final.isVisible()) ||
    (await final.innerText()).trim() !== "Apply"
  )
    throw unavailable("CMS did not expose the reviewed native Apply control.");
}
export async function inspectApplicationWorkflow(page: Page): Promise<ApplicationWorkflow> {
  const state = await snapshot(page);
  await inspectControls(page, state.documents);
  const fields: FormField[] = [];
  for (const d of state.documents) {
    const p = prefix(d.id);
    fields.push({
      id: p + "type",
      label: d.title + ": source",
      type: "select",
      required: true,
      value: d.type,
      options: [
        { value: "upload", label: "Upload New" },
        ...(d.existing.length ? [{ value: "existing", label: "Existing" }] : []),
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
      label: d.title + ": local file (conditional requirement)",
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
  return {
    posting_id: state.posting_id,
    applicant_id: state.applicant_id,
    fields,
    documents: state.documents,
    context: {
      workflow: "native_job_application",
      rules: state.rules,
      document_requirements: state.documents,
      effects: [
        "Upload each selected local file immediately",
        "Attach the exact selected documents to this application",
        "Save selected copies to the materials library",
        "Submit this student's application once",
      ],
    },
  };
}
export function validateApplicationWorkflow(workflow: ApplicationWorkflow, change: Change) {
  if (
    change.operation !== "application_submit" ||
    !["jobs", "applications"].includes(change.area) ||
    change.target_id !== workflow.posting_id ||
    change.slot_id
  )
    throw new CmsError("record_changed", "The job posting no longer matches this application.");
  validateFields(
    workflow.fields,
    change.fields,
    change.files.map((f) => f.field),
  );
  if (new Set(change.files.map((f) => f.field)).size !== change.files.length)
    throw new CmsError(
      "invalid_file_field",
      "Choose one file per application document requirement.",
    );
  for (const d of workflow.documents) {
    const p = prefix(d.id),
      mode = modeOf(change.fields[p + "type"] ?? d.type),
      file = change.files.find((f) => f.field === p + "file");
    if (mode === "existing") {
      if (
        file ||
        Object.hasOwn(change.fields, p + "name") ||
        Object.hasOwn(change.fields, p + "save_to_library")
      )
        throw new CmsError(
          "invalid_field",
          "Existing selection cannot also upload, rename, or save a new library copy.",
        );
      const selected = String(change.fields[p + "existing"] ?? d.existing_id);
      if (d.existing.filter((x) => x.id === selected || x.name === selected).length !== 1)
        throw new CmsError("required_field", "Choose an exact existing document.", {
          field: p + "existing",
        });
    } else if (mode === "upload") {
      if (Object.hasOwn(change.fields, p + "existing"))
        throw new CmsError("invalid_field", "An upload cannot also select an existing document.");
      if (
        (d.required ||
          Object.hasOwn(change.fields, p + "name") ||
          (change.fields[p + "save_to_library"] ?? d.save_to_library) === true) &&
        !file
      )
        throw new CmsError("required_file", "Choose the file required for this application.", {
          field: p + "file",
        });
      if (file && !String(change.fields[p + "name"] ?? d.name).trim())
        throw new CmsError("required_field", "Give the uploaded document a name.", {
          field: p + "name",
        });
      if (
        file &&
        d.allowed_extensions.length &&
        !d.allowed_extensions.some(
          (ext) => "." + ext.replace(/^\./, "").toLowerCase() === extname(file.path).toLowerCase(),
        )
      )
        throw new CmsError(
          "invalid_file",
          "The application uploader does not permit this file extension.",
          { field: p + "file", allowed_extensions: d.allowed_extensions },
        );
    } else throw new CmsError("invalid_choice", "Choose an observed application document source.");
  }
}
export async function fillApplicationWorkflow(
  page: Page,
  change: Change,
  recordEffect: RecordEffect,
): Promise<ApplicationSubmission> {
  const workflow = await inspectApplicationWorkflow(page);
  validateApplicationWorkflow(workflow, change);
  for (const file of change.files) {
    const d = workflow.documents.find((d) => file.field === prefix(d.id) + "file")!,
      info = await stat(file.path);
    if (!info.isFile() || (d.max_bytes !== null && info.size > d.max_bytes))
      throw new CmsError("invalid_file", "The file exceeds this application uploader's limits.", {
        field: file.field,
        max_bytes: d.max_bytes,
      });
  }
  const effects: Effect[] = [],
    uploads: ApplicationSubmission["uploads"] = [];
  const intend = async (name: string, details?: JsonRecord) => {
    const e: Effect = {
      name,
      status: "intended",
      target: change.target_id,
      ...(details ? { details } : {}),
    };
    await recordEffect(e);
    effects.push(e);
    return e;
  };
  const verify = async (e: Effect, details?: JsonRecord) => {
    e.status = "verified";
    if (details) e.details = { ...e.details, ...details };
    await recordEffect(e);
  };
  for (const d of workflow.documents) {
    const p = prefix(d.id),
      scope = await documentScope(page, d.id),
      mode = modeOf(change.fields[p + "type"] ?? d.type);
    const file = change.files.find((f) => f.field === p + "file");
    if (Object.keys(change.fields).some((key) => key.startsWith(p))) {
      const effect = await intend("application_document_fields:" + d.id);
      await assertRequirement(scope, d.id);
      await (
        await only(scope, 'input[type=radio][name="uploadType"][value="' + mode + '"]')
      ).check();
      if (mode === "existing") {
        const selected = String(change.fields[p + "existing"] ?? d.existing_id);
        const document = d.existing.find((x) => x.id === selected || x.name === selected)!;
        const select = await only(scope, controls.existing);
        const matches = await select
          .locator("option")
          .evaluateAll(
            (nodes, name) =>
              nodes
                .filter((n) => n.textContent?.trim() === name)
                .map((n) => (n as HTMLOptionElement).value),
            document.name,
          );
        if (matches.length !== 1)
          throw new CmsError(
            "ambiguous_field",
            "The native existing-document options are ambiguous.",
          );
        await select.selectOption(matches[0]);
      } else {
        if (Object.hasOwn(change.fields, p + "name"))
          await (await only(scope, controls.name)).fill(String(change.fields[p + "name"]));
        if (Object.hasOwn(change.fields, p + "save_to_library"))
          await (
            await only(scope, controls.library)
          ).setChecked(change.fields[p + "save_to_library"] as boolean);
      }
      const values = await scope.evaluate((el) => {
        const d = (window as any).angular.element(el).scope().requirement;
        return {
          type: d.type,
          name: d.Name,
          library: d.saveToApplicationMaterialsLibrary === true,
          existing: String(d.ExistingApplicationDocumentId ?? ""),
          external: !!d.sendToTopResume,
        };
      });
      const wanted = String(change.fields[p + "existing"] ?? d.existing_id),
        existing = d.existing.find((x) => x.id === wanted || x.name === wanted)?.id;
      if (
        values.type !== mode ||
        values.external ||
        (mode === "existing"
          ? values.existing !== existing
          : values.name !== String(change.fields[p + "name"] ?? d.name) ||
            values.library !==
              ((change.fields[p + "save_to_library"] ?? d.save_to_library) === true))
      )
        throw new CmsError(
          "record_changed",
          "CMS did not retain the approved application document fields.",
        );
      await verify(effect);
    }
    if (file) {
      const effect = await intend("application_document_upload:" + d.id, {
        document_type_id: d.id,
      });
      await assertRequirement(scope, d.id);
      const input = await (await only(scope, controls.file)).elementHandle();
      if (
        !input ||
        !(await input.evaluate((el, id) => {
          const row = el.closest('[ng-repeat="requirement in $ctrl.applicationFiles"]');
          const d = row && (window as any).angular.element(row).scope()?.requirement;
          return (
            String(d?.jobApplicationDocumentTypeId) === id &&
            !d.fileService.hasFiles() &&
            !d.fileService.isUploading &&
            !d.fileService.hasError()
          );
        }, d.id))
      )
        throw new CmsError("record_changed", "The exact application upload control changed.");
      await input.setInputFiles(file.path);
      try {
        await page.waitForFunction(
          (id) => {
            const c = (window as any).angular
              ?.element(document.querySelector("tt-jp-apply"))
              .controller("ttJpApply");
            const fs = c?.applicationFiles?.find(
              (d: any) => String(d.jobApplicationDocumentTypeId) === id,
            )?.fileService;
            return (
              !fs ||
              fs.hasError() ||
              (!fs.isUploading && fs.hasFiles() && fs.files.length === 1 && !!fs.files[0]?.FileId)
            );
          },
          d.id,
          { timeout: 60000 },
        );
      } catch {
        throw new CmsError(
          "upload_uncertain",
          "The application upload did not reach an acknowledged ready state.",
        );
      }
      const fileId = await scope.evaluate((el) => {
        const fs = (window as any).angular.element(el).scope().requirement.fileService;
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
          "CMS did not acknowledge the exact application upload.",
        );
      uploads.push({ document_type_id: d.id, uploaded_file_id: fileId });
      await verify(effect, { uploaded_file_id: fileId });
    }
  }
  const expected = {
    posting_id: workflow.posting_id,
    applicant_id: workflow.applicant_id,
    rules: workflow.context.rules,
    documents: workflow.documents.map((d) => {
      const p = prefix(d.id),
        wanted = String(change.fields[p + "existing"] ?? d.existing_id);
      return {
        ...d,
        type: modeOf(change.fields[p + "type"] ?? d.type),
        name: String(change.fields[p + "name"] ?? d.name),
        save_to_library: (change.fields[p + "save_to_library"] ?? d.save_to_library) === true,
        existing_id: d.existing.find((x) => x.id === wanted || x.name === wanted)?.id || "",
        file_id: uploads.find((x) => x.document_type_id === d.id)?.uploaded_file_id || "",
      };
    }),
  };
  const current = await snapshot(page, true);
  if (
    current.posting_id !== expected.posting_id ||
    current.applicant_id !== expected.applicant_id ||
    JSON.stringify(current.rules) !== JSON.stringify(expected.rules)
  )
    throw new CmsError("record_changed", "The application eligibility changed before submission.");
  await inspectControls(page, current.documents);
  for (const d of expected.documents) {
    if (d.type === "upload" && d.save_to_library)
      await intend("application_document_library:" + d.id, { document_type_id: d.id });
    if (d.file_id || d.type === "existing")
      await intend("application_document_attachment:" + d.id, {
        document_type_id: d.id,
        uploaded_file_id: d.file_id || null,
        existing_document_id: d.type === "existing" ? d.existing_id : null,
      });
  }
  await intend("application_submit", {
    posting_id: workflow.posting_id,
    applicant_id: workflow.applicant_id,
    uploads,
  });
  const clicked = await page.evaluate(
    ({ expected, selector }) => {
      const host = document.querySelector("tt-jp-apply"),
        c = (window as any).angular?.element(host).controller("ttJpApply"),
        j = c?.jobPosting;
      const str = (x: unknown) => (x === null || x === undefined ? "" : String(x));
      const session = (window as any).TT?.CurrentSession?.CurrentUser;
      const collections = host?.querySelectorAll("tt-attribute-input-collection");
      const questions =
        collections?.length === 1
          ? (window as any).angular.element(collections[0]).controller("ttAttributeInputCollection")
          : undefined;
      if (
        !c ||
        str(c.postingId) !== expected.posting_id ||
        str(j?.Id) !== expected.posting_id ||
        str(c.applicantId) !== expected.applicant_id ||
        str(c.currentUser?.Id) !== expected.applicant_id ||
        str(c.application?.ApplicantId) !== expected.applicant_id ||
        c.currentUser.IsStudent !== true ||
        c.currentUser.IsAdministrator ||
        !session ||
        str(session.Id) !== expected.applicant_id ||
        session.TypeId !== 2 ||
        (window as any).TT?.Types?.UserType?.Student !== 2 ||
        !Array.isArray(questions?.attributeGroups) ||
        questions.attributeGroups.length ||
        !Array.isArray(questions.revealedFieldNames) ||
        questions.revealedFieldNames.length ||
        Number(c.application.Id) !== 0 ||
        Number(j.CurrentUserApplication?.Id || 0) !== 0 ||
        j.ShouldApplyViaSite !== true ||
        j.ShouldApplyExternally ||
        j.ShouldApplyViaEmail ||
        j.ShouldApplyViaMail ||
        j.ShouldApplyViaFax ||
        c.needConfirmationPage ||
        c.isConfirmationStep ||
        c.isDocsStep !== true ||
        c.step !== c.docsStepId ||
        j.Rules?.CanApply !== true ||
        j.Rules.HasApplied ||
        j.Rules.IsEligibleToApply === false ||
        j.Rules.CanBid ||
        c.hasMultipleLocations ||
        c.rankedLocations?.length ||
        c.allowApprovedResumesOnly ||
        Object.keys(c.entity?.CustomAttributeValues || {}).length ||
        c.applicationFiles.length !== expected.documents.length
      )
        return false;
      const rules = expected.rules as { start: string; deadline: string };
      if (
        str(j.ApplicationStartDate) !== rules.start ||
        str(j.ApplicationDeadlineDate) !== rules.deadline
      )
        return false;
      for (const wanted of expected.documents) {
        const matches = c.applicationFiles.filter(
          (d: any) => str(d.jobApplicationDocumentTypeId) === wanted.id,
        );
        if (matches.length !== 1) return false;
        const d = matches[0],
          fs = d.fileService;
        if (
          d.displayTitle !== wanted.title ||
          d.isRequired !== wanted.required ||
          d.jobCoreApplicationDocumentTypeId !== wanted.core_type ||
          d.type !== wanted.type ||
          d.sendToTopResume ||
          !fs ||
          fs.isUploading ||
          fs.hasError()
        )
          return false;
        if (wanted.type === "existing") {
          if (
            !wanted.existing_id ||
            str(d.ExistingApplicationDocumentId) !== wanted.existing_id ||
            fs.hasFiles()
          )
            return false;
        } else if (
          str(d.Name) !== wanted.name ||
          (d.saveToApplicationMaterialsLibrary === true) !== wanted.save_to_library ||
          (wanted.file_id
            ? !fs.hasFiles() || fs.files.length !== 1 || str(fs.files[0].FileId) !== wanted.file_id
            : fs.hasFiles() || wanted.required)
        )
          return false;
      }
      const nodes = document.querySelectorAll<HTMLElement>(selector);
      if (
        nodes.length !== 1 ||
        !nodes[0].getClientRects().length ||
        nodes[0].hasAttribute("disabled") ||
        nodes[0].getAttribute("aria-disabled") === "true" ||
        nodes[0].textContent?.trim() !== "Apply"
      )
        return false;
      nodes[0].click();
      return true;
    },
    { expected, selector: finalSelector },
  );
  if (!clicked)
    throw new CmsError(
      "record_changed",
      "CMS changed the approved application before submission; the final action was not retried.",
    );
  // The caller waits for completion and verifies the applicant/posting/application ID.
  // Attachments and library copies remain intended until independently linked.
  return { effects, uploads };
}

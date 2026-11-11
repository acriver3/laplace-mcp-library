/** Sanitized DOM/controller shape observed on the native one-step application form. */
export function installApplicationForm(options = {}) {
  const documents = (
    options.docs || [{ id: "101", title: "Resume", required: true }]
  ).map((input) => ({
    jobApplicationDocumentTypeId: Number(input.id),
    jobCoreApplicationDocumentTypeId: input.coreType || 1,
    displayTitle: input.title,
    Name: input.title,
    isRequired: input.required,
    isNew: true,
    type: "upload",
    ExistingApplicationDocumentId: null,
    existing: input.existing || [],
    saveToApplicationMaterialsLibrary: false,
    fileService: {
      files: [],
      isUploading: false,
      error: false,
      AllowedExtensions: ["pdf"],
      attachmentSizeLimitInBytes: 5000,
      hasFiles() {
        return this.files.length > 0;
      },
      hasError() {
        return this.error;
      },
    },
  }));
  const c = {
    postingId: "123",
    applicantId: 7,
    currentUser: { Id: 7, IsStudent: true, IsAdministrator: false },
    application: { Id: 0, ApplicantId: 7, CustomAttributeValues: {} },
    jobPosting: {
      Id: 123,
      ShouldApplyViaSite: true,
      CurrentUserApplication: { Id: 0 },
      Rules: {
        CanApply: true,
        HasApplied: false,
        IsEligibleToApply: true,
        CanBid: false,
      },
      ApplicationStartDate: "2026-01-01T00:00:00",
      ApplicationDeadlineDate: "2030-01-01T00:00:00",
    },
    // The live zero-ID placeholder has isNew=false; this is not a submitted application.
    isNew: false,
    isDocsStep: true,
    isConfirmationStep: false,
    needConfirmationPage: null,
    step: 0,
    docsStepId: 0,
    hasMultipleLocations: false,
    rankedLocations: [],
    allowApprovedResumesOnly: false,
    entity: { CustomAttributeValues: {} },
    applicationFiles: documents,
  };
  const questions = { attributeGroups: [], revealedFieldNames: [] };
  window.TT = {
    CurrentSession: { CurrentUser: { Id: 7, TypeId: 2 } },
    Types: { UserType: { Student: 2 } },
  };
  window.controller = c;
  window.questions = questions;
  window.effects = [];
  window.requests = [];
  const host = document.querySelector("tt-jp-apply");
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  host.innerHTML =
    documents
      .map(
        (d) =>
          '<div ng-repeat="requirement in $ctrl.applicationFiles"><h4>' +
          escape(d.displayTitle) +
          (d.isRequired ? " (required)" : " (optional)") +
          "</h4><form>" +
          '<label style="display:none"><input type="radio" name="uploadType" data-ng-model="model.type" value="current">Current</label>' +
          '<label><input type="radio" name="uploadType" data-ng-model="model.type" value="upload" checked>Upload New</label>' +
          '<label style="' +
          (d.existing.length ? "" : "display:none") +
          '"><input type="radio" name="uploadType" data-ng-model="model.type" value="existing">Existing</label>' +
          '<div data-upload><input id="documentName" ng-model="model.Name"><label><input type="checkbox" name="saveToApplicationMaterialsLibrary" data-ng-model="model.saveToApplicationMaterialsLibrary">Save to library</label><input type="file" uploader="service" hidden></div>' +
          "<div data-existing>" +
          (d.existing.length
            ? '<select ng-model="model.ExistingApplicationDocumentId"><option value="">Choose</option>' +
              d.existing
                .map(
                  (x) =>
                    '<option value="number:' +
                    x.Id +
                    '">' +
                    escape(x.Name) +
                    "</option>",
                )
                .join("") +
              "</select>"
            : "") +
          "</div></form></div>",
      )
      .join("") +
    '<form><tt-attribute-input-collection></tt-attribute-input-collection></form><a role="button" tt-click="$ctrl.needConfirmationPage ? $ctrl.continue() : $ctrl.apply()" disabled>Apply</a>';
  const final = host.querySelector("[tt-click]");
  const refresh = () => {
    for (let i = 0; i < documents.length; i++) {
      const row = host.querySelectorAll("[ng-repeat]")[i],
        d = documents[i];
      row.querySelector("[data-upload]").style.display =
        d.type === "upload" ? "block" : "none";
      row.querySelector("[data-existing]").style.display =
        d.type === "existing" ? "block" : "none";
    }
    if (
      documents.every(
        (d) =>
          !d.isRequired ||
          (d.type === "existing"
            ? !!d.ExistingApplicationDocumentId
            : d.fileService.hasFiles()),
      )
    )
      final.removeAttribute("disabled");
    else final.setAttribute("disabled", "");
  };
  for (let i = 0; i < documents.length; i++) {
    const d = documents[i],
      row = host.querySelectorAll("[ng-repeat]")[i];
    row.requirement = d;
    for (const radio of row.querySelectorAll("input[type=radio]"))
      radio.addEventListener("change", () => {
        d.type = radio.value;
        window.effects.push("field:" + d.jobApplicationDocumentTypeId);
        refresh();
      });
    const name = row.querySelector("#documentName");
    name.value = d.Name;
    name.addEventListener("input", () => {
      d.Name = name.value;
      window.effects.push("field:" + d.jobApplicationDocumentTypeId);
    });
    row
      .querySelector("input[type=checkbox]")
      .addEventListener("change", (e) => {
        d.saveToApplicationMaterialsLibrary = e.target.checked;
        window.effects.push("field:" + d.jobApplicationDocumentTypeId);
      });
    row.querySelector("select")?.addEventListener("change", (e) => {
      d.ExistingApplicationDocumentId = Number(
        e.target.value.replace("number:", ""),
      );
      window.effects.push("field:" + d.jobApplicationDocumentTypeId);
      refresh();
    });
    row.querySelector("input[type=file]").addEventListener("change", () => {
      window.effects.push("upload:" + d.jobApplicationDocumentTypeId);
      if (options.failUpload === String(d.jobApplicationDocumentTypeId))
        d.fileService.error = true;
      else
        d.fileService.files = [
          { FileId: "file-" + d.jobApplicationDocumentTypeId },
        ];
      refresh();
    });
  }
  final.addEventListener("click", () => {
    window.effects.push("apply");
    window.requests.push({
      JobPostingId: c.jobPosting.Id,
      ApplicantId: c.applicantId,
      ApplicationDocumentInfoList: documents
        .filter(
          (d) => d.fileService.hasFiles() || d.ExistingApplicationDocumentId,
        )
        .map((d) => ({
          DocumentTypeId: d.jobApplicationDocumentTypeId,
          CoreApplicationDocumentTypeId: d.jobCoreApplicationDocumentTypeId,
          UploadedFileId:
            d.type === "upload" ? d.fileService.files[0]?.FileId : undefined,
          ExistingApplicationDocumentId:
            d.type === "existing" ? d.ExistingApplicationDocumentId : undefined,
          Name: d.Name,
          SaveToApplicationMaterialsLibrary:
            d.saveToApplicationMaterialsLibrary,
        })),
    });
    c.application.Id = 55;
  });
  window.angular = {
    element: (el) => ({
      controller: (name) =>
        name === "ttJpApply"
          ? c
          : name === "ttAttributeInputCollection"
            ? questions
            : undefined,
      scope: () => ({ requirement: el.requirement }),
    }),
  };
  refresh();
}

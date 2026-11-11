// Sanitized observed native tt-edit-registration documents/confirmation DOM.
export function installEventForm(options) {
  const docs = (
    options.docs || [{ id: "101", title: "Resume", required: true }]
  ).map((input) => {
    const d = {
      eventRegistrationDocumentTypeId: Number(input.id),
      registrationDocumentTypeCoreId: 1,
      displayTitle: input.title,
      isRequired: input.required,
      isNew: true,
      type: "upload",
      Name: input.title,
      ExistingApplicationDocumentId: null,
      existing: input.existing || [],
      saveToApplicationMaterialsLibrary: false,
    };
    const service = {
      files: [],
      isUploading: false,
      error: false,
      AllowedExtensions: ["pdf"],
      attachmentSizeLimitInBytes: 10000,
      hasFiles() {
        return this.files.length > 0;
      },
      hasError() {
        return this.error;
      },
    };
    d.fileService = service;
    return d;
  });
  const c = {
    eventId: "123",
    event: {
      Id: 123,
      RegistrationInstructions: null,
      RegistrationRules: {
        CanRegister: true,
        CanRegisterForWaitlist: false,
        IsAttending: false,
        IsOnWaitlist: false,
      },
    },
    studentId: 7,
    currentUser: { Id: 7, IsStudent: true },
    timeSlotId: options.slot,
    isReady: true,
    isNew: true,
    isTimeSlotExpired: false,
    isRegistrationBeingSubmitted: false,
    docsStepId: "docs",
    confirmationStepId: "confirm",
    enabledStepIds: options.confirmOnly ? ["confirm"] : ["docs", "confirm"],
    stepIndex: 0,
    preSurveyResponse: {},
    registrationDocuments: docs,
    goToStep: function (n) {
      this.stepIndex = n;
    },
    continue: function () {
      this.stepIndex++;
      this.stepIndex >= this.enabledStepIds.length &&
        (this.stepIndex = this.enabledStepIds.length - 1);
    },
  };
  Object.defineProperty(c, "currentStepId", {
    get() {
      return this.enabledStepIds[this.stepIndex];
    },
  });
  const host = document.querySelector("tt-edit-registration");
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  window.events = [];
  window.TT = {
    CurrentSession: { CurrentUser: { Id: 7, TypeId: 2 } },
    Types: { UserType: { Student: 2 } },
  };
  window.controller = c;
  const render = () => {
    if (c.currentStepId === "docs") {
      host.innerHTML =
        '<section ng-if="$ctrl.currentStepId == $ctrl.docsStepId">' +
        docs
          .map(
            (d) =>
              '<div class="registration-file" ng-repeat="requirement in $ctrl.registrationDocuments">' +
              "<h4>" +
              escape(d.displayTitle) +
              (d.isRequired ? " (required)" : " (optional)") +
              "</h4><form>" +
              '<label style="display:none"><input type="radio" name="uploadType" data-ng-model="model.type" value="current">Current</label>' +
              '<label><input type="radio" name="uploadType" data-ng-model="model.type" value="upload">Upload New</label>' +
              '<label style="' +
              (d.existing.length ? "" : "display:none") +
              '"><input type="radio" name="uploadType" data-ng-model="model.type" value="existing">Existing</label>' +
              '<div data-upload><input id="documentName" ng-model="model.Name"><label><input type="checkbox" name="saveToApplicationMaterialsLibrary" data-ng-model="model.saveToApplicationMaterialsLibrary">Save to library</label>' +
              '<input type="file" uploader="service" hidden></div>' +
              '<div data-existing><select ng-model="model.ExistingApplicationDocumentId"><option value="">Choose</option>' +
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
              "</select></div></form></div>",
          )
          .join("") +
        '<a role="button" ng-click="$ctrl.continue()" href="#">Continue</a></section>';
      for (let i = 0; i < docs.length; i++) {
        const row = host.querySelectorAll(".registration-file")[i],
          d = docs[i];
        row.requirement = d;
        const visibility = () => {
          row.querySelector("[data-upload]").style.display =
            d.type === "upload" ? "block" : "none";
          row.querySelector("[data-existing]").style.display =
            d.type === "existing" ? "block" : "none";
        };
        for (const radio of row.querySelectorAll('input[type="radio"]')) {
          radio.checked = radio.value === d.type;
          radio.addEventListener("change", () => {
            d.type = radio.value;
            window.events.push("fields:" + d.eventRegistrationDocumentTypeId);
            visibility();
          });
        }
        const name = row.querySelector("#documentName");
        name.value = d.Name;
        name.addEventListener("input", () => {
          d.Name = name.value;
          window.events.push("fields:" + d.eventRegistrationDocumentTypeId);
        });
        row.querySelector('input[type="checkbox"]').checked =
          d.saveToApplicationMaterialsLibrary;
        row
          .querySelector('input[type="checkbox"]')
          .addEventListener("change", (e) => {
            d.saveToApplicationMaterialsLibrary = e.target.checked;
            window.events.push("fields:" + d.eventRegistrationDocumentTypeId);
          });
        row.querySelector("select").value = d.ExistingApplicationDocumentId
          ? "number:" + d.ExistingApplicationDocumentId
          : "";
        row.querySelector("select").addEventListener("change", (e) => {
          d.ExistingApplicationDocumentId = Number(
            e.target.value.replace("number:", ""),
          );
          window.events.push("fields:" + d.eventRegistrationDocumentTypeId);
        });
        row
          .querySelector('input[type="file"]')
          .addEventListener("change", async () => {
            window.events.push("upload:" + d.eventRegistrationDocumentTypeId);
            await window.fixtureUpload?.(
              String(d.eventRegistrationDocumentTypeId),
            );
            if (
              options.failUpload === String(d.eventRegistrationDocumentTypeId)
            )
              d.fileService.error = true;
            else
              d.fileService.files = [
                { FileId: "file-" + d.eventRegistrationDocumentTypeId },
              ];
          });
        visibility();
      }
      host
        .querySelector('[ng-click="$ctrl.continue()"]')
        .addEventListener("click", (e) => {
          e.preventDefault();
          c.continue();
          render();
        });
    } else {
      host.innerHTML =
        '<section ng-if="$ctrl.currentStepId == $ctrl.confirmationStepId"><div>Are you sure you want to register for this event?</div><a role="button" tt-click="$ctrl.save()" href="#">Register</a></section>';
      host
        .querySelector('[tt-click="$ctrl.save()"]')
        .addEventListener("click", (e) => {
          e.preventDefault();
          window.events.push("submit");
          c.isRegistrationBeingSubmitted = true;
          void window.fixtureOnSubmit?.(c);
        });
    }
  };
  window.angular = {
    element: (el) => ({
      controller: (name) => (name === "ttEditRegistration" ? c : undefined),
      scope: () => ({ requirement: el.requirement }),
      isolateScope: () => ({
        $root: {},
        $apply: (fn) => {
          fn();
          render();
        },
      }),
    }),
  };
  render();
}

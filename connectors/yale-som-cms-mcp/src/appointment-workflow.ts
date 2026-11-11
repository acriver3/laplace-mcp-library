import type { Locator, Page } from "playwright-core";
import {
  CMS_ORIGIN,
  CmsError,
  TIMEZONE,
  type Change,
  type JsonRecord,
} from "./types.js";

export type AppointmentOperation = "appointment_book" | "appointment_cancel";
export interface AppointmentSlot {
  slot_id: string;
  start: string;
  end: string;
}
export interface AppointmentWorkflow {
  operation: AppointmentOperation;
  target_id: string;
  appointment_id: string | null;
  block_id: string | null;
  slots: AppointmentSlot[];
  selected_slot_id: string | null;
  context: JsonRecord;
}
const unavailable = (message: string) =>
  new CmsError("action_unavailable", message);
/** The site's timeSpan.id is a transient array index. Our local ID binds exact instants. */
export const appointmentSlotId = (
  blockId: string,
  start: string,
  end: string,
) => `${blockId}:${start}/${end}`;

export async function inspectAppointmentWorkflow(
  page: Page,
  operation: AppointmentOperation,
  targetId: string,
): Promise<AppointmentWorkflow> {
  if (!["appointment_book", "appointment_cancel"].includes(operation))
    throw unavailable("This is not a reviewed appointment operation.");
  if (!/^\d+$/.test(targetId))
    throw new CmsError(
      "invalid_id",
      "Use the exact appointment or available-block ID returned by CMS.",
    );
  const url = new URL(page.url());
  if (
    url.origin !== CMS_ORIGIN ||
    !/^\/appointments(?:\/|$)/i.test(url.pathname)
  )
    throw unavailable(
      "The appointment workflow is outside the Yale CMS appointment page.",
    );
  const state = await page.evaluate(
    ({ operation, targetId }) => {
      const w = window as any,
        angular = w.angular,
        user = w.TT?.CurrentSession?.CurrentUser;
      const str = (v: any) => (v === undefined || v === null ? "" : String(v));
      const iso = (v: any) => {
        const value =
          typeof v?.toISOString === "function" ? v.toISOString() : v;
        return typeof value === "string" &&
          /Z$|[+-]\d\d:\d\d$/.test(value) &&
          Number.isFinite(Date.parse(value))
          ? new Date(value).toISOString()
          : null;
      };
      if (!user?.Id)
        return { error: "The current CMS account is unavailable." };
      if (operation === "appointment_book") {
        const elements = document.querySelectorAll("tt-appointment-form");
        if (elements.length !== 1)
          return {
            error: "CMS did not expose one native appointment booking form.",
          };
        const c = angular?.element(elements[0]).controller("ttAppointmentForm"),
          a = c?.appointment;
        if (!c?.isInitialized || !a || !Array.isArray(c.availableTimes))
          return { error: "The appointment booking form is not ready." };
        if (
          c.currentUser?.IsStudent !== true ||
          c.isStudent !== true ||
          c.isAdmin === true ||
          str(a.StudentId) !== str(user.Id) ||
          str(c.currentUser.Id) !== str(user.Id)
        )
          return {
            error: "Only booking for the signed-in student is supported.",
          };
        if (
          a.Id !== 0 ||
          a.isNew !== true ||
          a.hasBlock !== true ||
          a.IsAttendanceTracking === true ||
          c.isAttendanceTracking === true ||
          c.queueEntry
        )
          return {
            error:
              "Only a new appointment from an available block is supported; attendance, queues, and edits require their own workflow.",
          };
        if (
          str(a.AppointmentBlockId) !== targetId ||
          str(a.AppointmentBlock?.Id) !== targetId
        )
          return {
            error:
              "The booking form does not match the requested appointment block.",
          };
        const action = a.AppointmentBlock?.State?.Actions?.find(
          (x: any) => x.ActionTypeId === 8,
        );
        if (action?.IsAvailable !== true)
          return {
            error:
              action?.ReasonNotAvailable ||
              "CMS no longer permits booking this appointment block.",
          };
        const slots = [];
        for (const t of c.availableTimes) {
          const start = iso(t.start),
            end = iso(t.end);
          if (!start || !end || Date.parse(end) <= Date.parse(start))
            return { error: "An appointment slot has an ambiguous time." };
          slots.push({
            slot_id: targetId + ":" + start + "/" + end,
            start,
            end,
          });
        }
        if (new Set(slots.map((s) => s.slot_id)).size !== slots.length)
          return { error: "The appointment time slots are ambiguous." };
        const start = iso(a.StartTime),
          end = iso(a.EndTime);
        const selected = slots.find((s) => s.start === start && s.end === end);
        const uploader = c.fileUploader;
        return {
          appointment_id: null,
          block_id: targetId,
          slots,
          selected_slot_id: selected?.slot_id || null,
          context: {
            timezone: "America/New_York",
            account_matches: true,
            new_appointment: true,
            preferred_appointment_type_id:
              str(a.PreferredAppointmentTypeId) || null,
            location_type_id: str(a.LocationTypeId) || null,
            ...(a.Topic !== undefined ? { topic: String(a.Topic ?? "") } : {}),
            form_valid: c.form?.$valid === true,
            attachment_file_ids:
              typeof uploader?.getFileIds === "function"
                ? uploader.getFileIds().map(String)
                : [],
            uploading: uploader?.isUploading === true,
            upload_error:
              typeof uploader?.hasError === "function"
                ? uploader.hasError()
                : false,
          },
        };
      }
      const elements = document.querySelectorAll("tt-appointment-detail");
      if (elements.length !== 1)
        return {
          error: "CMS did not expose one appointment detail for cancellation.",
        };
      const c = angular?.element(elements[0]).controller("ttAppointmentDetail"),
        a = c?.appointment;
      if (!a || str(a.Id) !== targetId)
        return {
          error:
            "The appointment detail does not match the requested appointment ID.",
        };
      if (
        c.currentUser?.IsStudent !== true ||
        str(c.currentUser.Id) !== str(user.Id) ||
        str(a.StudentId) !== str(user.Id)
      )
        return {
          error:
            "Only cancellation of the signed-in student’s appointment is supported.",
        };
      const action = a.State?.Actions?.find((x: any) => x.ActionTypeId === 10);
      if (a.StatusId !== 1 || action?.IsAvailable !== true)
        return {
          error:
            action?.ReasonNotAvailable ||
            "CMS does not permit cancelling this appointment; its deadline may have passed.",
        };
      return {
        appointment_id: targetId,
        block_id: str(a.AppointmentBlockId) || null,
        slots: [],
        selected_slot_id: null,
        context: {
          timezone: "America/New_York",
          account_matches: true,
          status_id: a.StatusId,
          can_cancel: true,
          start: iso(a.StartTime),
          end: iso(a.EndTime),
        },
      };
    },
    { operation, targetId },
  );
  if (state.error) throw unavailable(state.error);
  if (
    operation === "appointment_book" &&
    (url.pathname !== "/appointments/create" ||
      url.searchParams.getAll("blockId").length !== 1 ||
      url.searchParams.get("blockId") !== targetId)
  )
    throw unavailable(
      "The native booking route does not match its exact appointment block.",
    );
  return { operation, target_id: targetId, ...state } as AppointmentWorkflow;
}

/** Open only the reviewed local form/confirmation. The persistent browser guard stays active. */
export async function openAppointmentWorkflow(
  page: Page,
  change: Change,
): Promise<AppointmentWorkflow> {
  if (
    !["appointment_book", "appointment_cancel"].includes(change.operation) ||
    change.area !== "appointments" ||
    !change.target_id
  )
    throw new CmsError(
      "invalid_target",
      "Choose an exact appointment or available-block ID.",
    );
  const operation = change.operation as AppointmentOperation;
  if (new URL(page.url()).origin !== CMS_ORIGIN)
    throw unavailable("Open the Yale CMS appointment page first.");
  if (operation === "appointment_book") {
    const already = await page.locator("tt-appointment-form").count();
    if (!already) {
      const verified = await page.evaluate((id) => {
        const es = document.querySelectorAll(".block-modal");
        if (es.length !== 1) return false;
        const c = (window as any).angular?.element(es[0]).data("$scope")?.$ctrl;
        return (
          String(c?.block?.Id) === id &&
          c?.block?.State?.Actions?.some(
            (x: any) => x.ActionTypeId === 8 && x.IsAvailable === true,
          )
        );
      }, change.target_id);
      if (!verified)
        throw unavailable(
          "Read/open the exact available appointment block before viewing its slots.",
        );
      const opener = page.locator(
        '.block-modal [tt-click="$ctrl.bookAppointment()"]',
      );
      if ((await opener.count()) !== 1)
        throw unavailable("The appointment availability opener has changed.");
      await opener.evaluate((e) => (e as HTMLElement).click());
      await page.waitForFunction(
        () => {
          const e = document.querySelector("tt-appointment-form");
          const c =
            e &&
            (window as any).angular?.element(e).controller("ttAppointmentForm");
          const injector = (window as any).angular
            ?.element(document.body)
            .injector();
          const pending = injector?.has("$http")
            ? injector.get("$http").pendingRequests
            : [];
          return (
            c?.isInitialized &&
            Array.isArray(c.availableTimes) &&
            c.appointmentBookingConfigInfo &&
            !pending.some((r: any) =>
              /appointment-blocks|appointment-booking/.test(r.url),
            )
          );
        },
        undefined,
        { timeout: 20_000 },
      );
    }
  } else {
    await inspectAppointmentWorkflow(page, operation, change.target_id);
    const opener = page.locator(
      'tt-appointment-detail [ng-click="$ctrl.cancelAppointment()"]',
    );
    if ((await opener.count()) !== 1)
      throw unavailable("The appointment cancellation control has changed.");
    await opener.evaluate((e) => (e as HTMLElement).click());
    await cancellationControl(page).waitFor({
      state: "visible",
      timeout: 10_000,
    });
  }
  return inspectAppointmentWorkflow(page, operation, change.target_id);
}

export function validateAppointmentWorkflow(
  workflow: AppointmentWorkflow,
  change: Change,
) {
  if (
    change.operation !== workflow.operation ||
    change.target_id !== workflow.target_id ||
    change.area !== "appointments"
  )
    throw new CmsError(
      "invalid_target",
      "The appointment operation does not match the inspected form.",
    );
  if (workflow.operation === "appointment_book") {
    if (
      !change.slot_id ||
      !workflow.slots.some((s) => s.slot_id === change.slot_id)
    )
      throw new CmsError(
        "invalid_slot",
        "Choose an exact slot_id from the appointment form. Slot IDs bind the block and UTC start/end, not the site’s transient row index.",
        { slots: workflow.slots, timezone: TIMEZONE },
      );
  } else if (
    change.slot_id ||
    Object.keys(change.fields).length ||
    change.files.length
  )
    throw new CmsError(
      "invalid_fields",
      "Appointment cancellation accepts only its exact appointment ID.",
    );
}

/** Select only a slot exposed by the current form; changes local form state, never books. */
export async function selectAppointmentSlot(
  page: Page,
  change: Change,
): Promise<AppointmentWorkflow> {
  await page.waitForFunction(
    () => {
      const w = window as any;
      const e = document.querySelector("tt-appointment-form");
      const c = e && w.angular?.element(e).controller("ttAppointmentForm");
      const injector = w.angular?.element(document.body).injector();
      const pending = injector?.has("$http")
        ? injector.get("$http").pendingRequests
        : [];
      return (
        c?.isInitialized &&
        !pending.some((r: any) =>
          /appointment-blocks|appointment-booking/.test(r.url),
        )
      );
    },
    undefined,
    { timeout: 20_000 },
  );
  const before = await inspectAppointmentWorkflow(
    page,
    "appointment_book",
    change.target_id || "",
  );
  validateAppointmentWorkflow(before, change);
  const selected = await page.evaluate(
    ({ blockId, slotId }) => {
      const e = document.querySelector("tt-appointment-form");
      const c =
        e &&
        (window as any).angular?.element(e).controller("ttAppointmentForm");
      if (
        String(c?.appointment?.AppointmentBlockId) !== blockId ||
        typeof c?.setAppointmentTimes !== "function"
      )
        return false;
      const matches = c.availableTimes.filter(
        (t: any) =>
          blockId + ":" + t.start.toISOString() + "/" + t.end.toISOString() ===
          slotId,
      );
      if (matches.length !== 1) return false;
      c.setAppointmentTimes(matches[0]);
      return true;
    },
    { blockId: change.target_id, slotId: change.slot_id },
  );
  if (!selected)
    throw new CmsError(
      "slot_changed",
      "The requested appointment slot is no longer available. Read its form again.",
    );
  const after = await inspectAppointmentWorkflow(
    page,
    "appointment_book",
    change.target_id!,
  );
  if (after.selected_slot_id !== change.slot_id)
    throw new CmsError(
      "slot_changed",
      "CMS did not preserve the exact selected appointment time.",
    );
  return after;
}
const cancellationControl = (page: Page) =>
  page
    .locator(".modal-dialog")
    .filter({
      has: page.getByRole("heading", {
        name: "Cancel the Appointment",
        exact: true,
      }),
    })
    .getByRole("button", { name: "Yes, cancel it", exact: true });

/** Return the one final UI control; the caller supplies its confirmation/journal and runMutation scope. */
export async function appointmentSubmitControl(
  page: Page,
  change: Change,
): Promise<Locator> {
  const workflow = await inspectAppointmentWorkflow(
    page,
    change.operation as AppointmentOperation,
    change.target_id || "",
  );
  validateAppointmentWorkflow(workflow, change);
  if (
    workflow.operation === "appointment_book" &&
    (workflow.selected_slot_id !== change.slot_id ||
      workflow.context.form_valid !== true ||
      workflow.context.uploading === true ||
      workflow.context.upload_error === true)
  )
    throw unavailable(
      "Complete the native required fields, exact time-slot selection, and uploads before booking.",
    );
  const control =
    workflow.operation === "appointment_book"
      ? page.locator('tt-appointment-form [tt-click="$ctrl.save()"]')
      : cancellationControl(page);
  if (
    (await control.count()) !== 1 ||
    !(await control.isVisible()) ||
    (await control.isDisabled()) ||
    (await control.getAttribute("aria-disabled")) === "true"
  )
    throw unavailable(
      "CMS does not expose one enabled final appointment action.",
    );
  return control;
}

/** Revalidate the own target in the same browser task as the final click. */
export async function clickAppointmentSubmit(
  page: Page,
  change: Change,
): Promise<void> {
  await appointmentSubmitControl(page, change);
  const workflow = await inspectAppointmentWorkflow(
    page,
    change.operation as AppointmentOperation,
    change.target_id!,
  );
  const slot = workflow.slots.find((s) => s.slot_id === change.slot_id);
  const clicked = await page.evaluate(
    ({ change, slot, context }) => {
      if (location.origin !== "https://som-yale.12twenty.com") return false;
      const w = window as any,
        user = w.TT?.CurrentSession?.CurrentUser;
      const own = (c: any, a: any) =>
        c?.currentUser?.IsStudent === true &&
        String(c.currentUser.Id) === String(user?.Id) &&
        String(a?.StudentId) === String(user?.Id);
      let controls: Element[] = [];
      if (change.operation === "appointment_book") {
        const roots = document.querySelectorAll("tt-appointment-form");
        if (roots.length !== 1) return false;
        const c = w.angular?.element(roots[0]).controller("ttAppointmentForm"),
          a = c?.appointment;
        if (
          !own(c, a) ||
          c.isStudent !== true ||
          c.isAdmin === true ||
          a.Id !== 0 ||
          a.isNew !== true ||
          a.hasBlock !== true ||
          a.IsAttendanceTracking ||
          c.isAttendanceTracking ||
          c.queueEntry ||
          String(a.AppointmentBlockId) !== change.target_id ||
          String(a.AppointmentBlock?.Id) !== change.target_id ||
          !a.AppointmentBlock.State?.Actions?.some(
            (x: any) => x.ActionTypeId === 8 && x.IsAvailable === true,
          ) ||
          c.form?.$valid !== true ||
          c.fileUploader?.isUploading ||
          c.fileUploader?.hasError?.()
        )
          return false;
        const iso = (x: any) =>
          typeof x === "string" &&
          /Z$|[+-]\d\d:\d\d$/.test(x) &&
          Number.isFinite(Date.parse(x))
            ? new Date(x).toISOString()
            : null;
        if (
          !slot ||
          iso(a.StartTime) !== slot.start ||
          iso(a.EndTime) !== slot.end ||
          !c.availableTimes.some(
            (t: any) =>
              t.start.toISOString() === slot.start &&
              t.end.toISOString() === slot.end,
          ) ||
          JSON.stringify(c.fileUploader.getFileIds().map(String)) !==
            JSON.stringify(context.attachment_file_ids)
        )
          return false;
        controls = [...roots[0].querySelectorAll('[tt-click="$ctrl.save()"]')];
      } else {
        const roots = document.querySelectorAll("tt-appointment-detail");
        if (roots.length !== 1) return false;
        const c = w.angular
            ?.element(roots[0])
            .controller("ttAppointmentDetail"),
          a = c?.appointment;
        if (
          !own(c, a) ||
          String(a.Id) !== change.target_id ||
          a.StatusId !== 1 ||
          !a.State?.Actions?.some(
            (x: any) => x.ActionTypeId === 10 && x.IsAvailable === true,
          )
        )
          return false;
        const dialogs = [...document.querySelectorAll(".modal-dialog")].filter(
          (e) =>
            [...e.querySelectorAll("h1,h2,h3,h4,[role=heading]")].some(
              (h) => h.textContent?.trim() === "Cancel the Appointment",
            ),
        );
        if (dialogs.length !== 1) return false;
        controls = [
          ...dialogs[0].querySelectorAll("button,[role=button]"),
        ].filter((e) => e.textContent?.trim() === "Yes, cancel it");
      }
      if (
        controls.length !== 1 ||
        !controls[0].getClientRects().length ||
        controls[0].hasAttribute("disabled") ||
        controls[0].getAttribute("aria-disabled") === "true"
      )
        return false;
      (controls[0] as HTMLElement).click();
      return true;
    },
    { change, slot, context: workflow.context },
  );
  if (!clicked)
    throw new CmsError(
      "record_changed",
      "The exact own appointment target changed before the final action. The action was not retried.",
    );
}

export interface AppointmentReceipt {
  verified: boolean;
  url: string;
  appointment_id?: string;
  state?: JsonRecord;
  attachment_file_ids?: string[];
  reason?: string;
}
/** Call only after the observed final request settles; never issue a second write. */
export async function verifyAppointmentOutcome(
  page: Page,
  change: Change,
  workflow: AppointmentWorkflow,
  timeoutMs = 10_000,
): Promise<AppointmentReceipt> {
  validateAppointmentWorkflow(workflow, change);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
    throw new CmsError(
      "invalid_timeout",
      "Appointment verification allows at most 30 seconds.",
    );
  const deadline = Date.now() + timeoutMs;
  const expectedSlot = workflow.slots.find((s) => s.slot_id === change.slot_id);
  if (new URL(page.url()).origin !== CMS_ORIGIN)
    return {
      verified: false,
      url: page.url(),
      reason: "The appointment confirmation left the Yale CMS page.",
    };
  if (change.operation === "appointment_cancel") {
    // The reviewed cancel handler closes its slideout after the successful PUT.
    // Reload that previously verified own record through the site's read-only UI.
    // Wait for the old slideout to close instead of stacking a second detail on it.
    try {
      await page.waitForFunction(
        (id) => {
          const roots = document.querySelectorAll("tt-appointment-detail");
          if (!roots.length) return true;
          if (roots.length !== 1) return false;
          const c = (window as any).angular
            ?.element(roots[0])
            .controller("ttAppointmentDetail");
          return (
            String(c?.appointment?.Id) === id && c.appointment.StatusId === 2
          );
        },
        change.target_id!,
        { timeout: Math.max(1, Math.min(1500, deadline - Date.now())) },
      );
    } catch {
      return {
        verified: false,
        url: page.url(),
        reason:
          "The cancellation view has not settled. Do not retry the cancellation automatically.",
      };
    }
    await page.evaluate((id) => {
      const detail = document.querySelector("tt-appointment-detail");
      const d =
        detail &&
        (window as any).angular
          ?.element(detail)
          .controller("ttAppointmentDetail");
      if (String(d?.appointment?.Id) === id && d.appointment.StatusId === 2)
        return;
      const e = document.querySelector("tt-appointment-home");
      const c =
        e &&
        (window as any).angular?.element(e).controller("ttAppointmentHome");
      if (typeof c?.showDetailSlideout === "function") c.showDetailSlideout(id);
    }, change.target_id!);
  }
  const expected = {
    operation: change.operation,
    targetId: change.target_id,
    blockId: workflow.block_id,
    start: expectedSlot?.start,
    end: expectedSlot?.end,
  };
  try {
    await page.waitForFunction(
      ({ operation, targetId, blockId, start, end }) => {
        const roots = document.querySelectorAll("tt-appointment-detail");
        if (roots.length !== 1) return false;
        const c = (window as any).angular
            ?.element(roots[0])
            .controller("ttAppointmentDetail"),
          a = c?.appointment,
          user = (window as any).TT?.CurrentSession?.CurrentUser;
        const iso = (v: any) => {
          const x = typeof v?.toISOString === "function" ? v.toISOString() : v;
          return typeof x === "string" &&
            /Z$|[+-]\d\d:\d\d$/.test(x) &&
            Number.isFinite(Date.parse(x))
            ? new Date(x).toISOString()
            : null;
        };
        if (
          !a ||
          !(a.Id > 0) ||
          c.currentUser?.IsStudent !== true ||
          String(a.StudentId) !== String(user?.Id) ||
          String(c.currentUser.Id) !== String(user?.Id)
        )
          return false;
        if (operation === "appointment_cancel")
          return String(a.Id) === targetId && a.StatusId === 2;
        return (
          String(a.AppointmentBlockId) === blockId &&
          a.StatusId === 1 &&
          iso(a.StartTime) === start &&
          iso(a.EndTime) === end
        );
      },
      expected,
      { timeout: Math.max(1, deadline - Date.now()) },
    );
  } catch {
    return {
      verified: false,
      url: page.url(),
      reason:
        "CMS did not expose an authoritative own-appointment receipt with the exact requested ID or time slot. Do not retry the write automatically.",
    };
  }
  const state = await page.evaluate(() => {
    const roots = document.querySelectorAll("tt-appointment-detail");
    if (roots.length !== 1) return null;
    const c = (window as any).angular
        ?.element(roots[0])
        .controller("ttAppointmentDetail"),
      a = c?.appointment,
      user = (window as any).TT?.CurrentSession?.CurrentUser;
    const iso = (v: any) => {
      const x = typeof v?.toISOString === "function" ? v.toISOString() : v;
      return typeof x === "string" &&
        /Z$|[+-]\d\d:\d\d$/.test(x) &&
        Number.isFinite(Date.parse(x))
        ? new Date(x).toISOString()
        : null;
    };
    if (
      !a ||
      !(a.Id > 0) ||
      c.currentUser?.IsStudent !== true ||
      String(a.StudentId) !== String(user?.Id) ||
      String(c.currentUser.Id) !== String(user?.Id)
    )
      return null;
    return {
      appointment_id: String(a.Id),
      block_id:
        a.AppointmentBlockId == null ? null : String(a.AppointmentBlockId),
      status_id: a.StatusId,
      start: iso(a.StartTime),
      end: iso(a.EndTime),
      topic: a.Topic == null ? null : String(a.Topic),
      preferred_appointment_type_id:
        a.PreferredAppointmentTypeId == null
          ? null
          : String(a.PreferredAppointmentTypeId),
      location_type_id:
        a.LocationTypeId == null ? null : String(a.LocationTypeId),
      attachment_file_ids: Array.isArray(a.Attachments)
        ? a.Attachments.filter(
            (x: any) => x?.FileId !== undefined && x?.FileId !== null,
          ).map((x: any) => String(x.FileId))
        : [],
    };
  });
  const currentUrl = new URL(page.url());
  const valid =
    state &&
    currentUrl.origin === CMS_ORIGIN &&
    (change.operation === "appointment_cancel"
      ? state.appointment_id === change.target_id && state.status_id === 2
      : state.block_id === workflow.block_id &&
        state.status_id === 1 &&
        state.start === expectedSlot?.start &&
        state.end === expectedSlot?.end &&
        ((change.fields.Topic === undefined &&
          change.fields.appointment__topic === undefined &&
          workflow.context.topic === undefined) ||
          String(state.topic ?? "") ===
            String(
              change.fields.Topic ??
                change.fields.appointment__topic ??
                workflow.context.topic ??
                "",
            )) &&
        state.preferred_appointment_type_id ===
          workflow.context.preferred_appointment_type_id &&
        state.location_type_id === workflow.context.location_type_id &&
        currentUrl.searchParams.get("appointmentId") === state.appointment_id);
  if (!valid)
    return {
      verified: false,
      url: page.url(),
      reason: "The account or appointment receipt changed during verification.",
    };
  return {
    verified: true,
    url: page.url(),
    appointment_id: state.appointment_id,
    state,
    attachment_file_ids: state.attachment_file_ids,
  };
}

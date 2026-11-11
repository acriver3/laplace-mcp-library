import assert from "node:assert/strict";
import test from "node:test";

import { validateFields } from "../dist/forms.js";
const field = (extra = {}) => ({
  id: "answer",
  label: "Answer",
  type: "text",
  required: false,
  ...extra,
});
const fails = (fn, code) => assert.throws(fn, (error) => error.code === code);

test("required checkbox requires true, including inherited and explicit false", () => {
  const fields = [field({ type: "checkbox", required: true, value: false })];
  fails(() => validateFields(fields, {}, []), "required_field");
  fails(() => validateFields(fields, { answer: false }, []), "required_field");
  validateFields(fields, { answer: true }, []);
  validateFields([field({ type: "checkbox", required: true, value: true })], {}, []);
  validateFields([field({ type: "checkbox" })], { answer: false }, []);
  fails(() => validateFields(fields, { answer: "true" }, []), "invalid_field");
});

test("required choices cannot be omitted; radio only accepts one current enabled choice", () => {
  const fields = [
    field({
      type: "radio",
      required: true,
      value: "",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
        { value: "old", label: "Old", disabled: true },
      ],
    }),
  ];
  fails(() => validateFields(fields, {}, []), "required_field");
  fails(() => validateFields(fields, { answer: ["yes", "no"] }, []), "invalid_field");
  fails(() => validateFields(fields, { answer: "old" }, []), "invalid_choice");
  validateFields(fields, { answer: "Yes" }, []);
});

test("duplicate choice labels and label/value collisions fail rather than select the first", () => {
  const fields = [
    field({
      type: "select",
      options: [
        { value: "one", label: "Shared" },
        { value: "two", label: "Shared" },
        { value: "Shared", label: "Third" },
      ],
    }),
  ];
  fails(() => validateFields(fields, { answer: "Shared" }, []), "invalid_choice");
  validateFields(fields, { answer: "one" }, []);
});

test("duplicate field IDs fail even if no changes were proposed", () => {
  fails(() => validateFields([field(), field()], {}, []), "ambiguous_field");
});

test("unknown, read-only, and scalar file fields are rejected", () => {
  fails(() => validateFields([field()], { unknown: "x" }, []), "invalid_field");
  fails(() => validateFields([field({ read_only: true })], { answer: "x" }, []), "invalid_field");
  fails(
    () => validateFields([field({ type: "file" })], { answer: "/tmp/file" }, []),
    "invalid_field",
  );
  fails(() => validateFields([field()], {}, ["answer"]), "invalid_file_field");
  fails(
    () => validateFields([field({ type: "file", read_only: true })], {}, ["answer"]),
    "invalid_file_field",
  );
});

test("required files require explicit file binding and reserved metadata remains separate", () => {
  const fields = [field({ type: "file", required: true })];
  fails(() => validateFields(fields, {}, []), "required_field");
  validateFields(fields, { _section: "General" }, ["answer"], ["_section"]);
});

test("multiple values are permitted only for a multiselect", () => {
  fails(() => validateFields([field()], { answer: ["a"] }, []), "invalid_field");
  const fields = [
    field({
      type: "multiselect",
      required: true,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    }),
  ];
  fails(() => validateFields(fields, { answer: [] }, []), "required_field");
  validateFields(fields, { answer: ["A", "b"] }, []);
});

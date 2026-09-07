// Shared client-side validation for FormField/FormSelect/FormTextarea.
// Imported (not duplicated) from each so bundlers dedupe it to one module
// per page regardless of how many field components render.

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

// Fields that opt in (`data-require-change`) aren't satisfied just because
// a value is present — a value a moderator never actually chose (e.g. one
// silently restored by the browser's own form-history-on-navigation
// behavior) must not pass as a real selection. Tracked in memory rather
// than a DOM attribute so a script-dispatched "change" (the batch-entry
// session-memory restore) counts as a real choice exactly like a click does,
// while a value the browser drops in on page load — which fires no event
// at all — does not.
const changedFields = new WeakSet<Field>();

function requiresChange(field: Field): boolean {
  return field.dataset.requireChange === "true";
}

function isEffectivelyValid(field: Field): boolean {
  if (requiresChange(field) && !changedFields.has(field)) return false;
  return field.validity.valid;
}

function getLabel(field: Element): HTMLElement | null {
  return field.closest("label");
}

// Native type -> noun for messages about format, not presence
// ("Enter a valid email address", not "Enter a valid email").
const TYPE_NOUNS: Record<string, string> = {
  email: "email address",
  url: "URL",
};

// "one-off date" takes "a", not "an" — vowel spelling, consonant sound.
function articleFor(noun: string): "a" | "an" {
  if (/^one\b/i.test(noun)) return "a";
  return /^[aeiou]/i.test(noun) ? "an" : "a";
}

function getFieldNoun(field: Field): string {
  const span = getLabel(field)?.querySelector<HTMLElement>(":scope > span");
  const raw = (span?.textContent ?? field.name).trim();
  return raw
    .replace(/\s*\*\s*$/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .toLowerCase();
}

function messageFor(field: Field): string {
  const { validity } = field;
  const noun = getFieldNoun(field);

  if (requiresChange(field) && !changedFields.has(field)) {
    return `Choose ${articleFor(noun)} ${noun}`;
  }
  if (validity.valueMissing) {
    if (field instanceof HTMLSelectElement) {
      return `Choose ${articleFor(noun)} ${noun}`;
    }
    if (field instanceof HTMLTextAreaElement) return `Add the ${noun}`;
    if (field.type === "date" || field.type === "time") {
      return `Pick ${articleFor(noun)} ${noun}`;
    }
    return `Add ${articleFor(noun)} ${noun}`;
  }
  if (validity.typeMismatch || validity.badInput) {
    return `Enter a valid ${TYPE_NOUNS[field.type] ?? noun}`;
  }
  if (
    validity.tooShort ||
    validity.tooLong ||
    validity.patternMismatch ||
    validity.rangeUnderflow ||
    validity.rangeOverflow ||
    validity.stepMismatch
  ) {
    return `Check the ${noun}`;
  }
  return field.validationMessage;
}

function clearInvalid(field: Field): void {
  field.style.borderColor = "";
  field.removeAttribute("aria-invalid");
  field.removeAttribute("aria-describedby");
  getLabel(field)
    ?.querySelector<HTMLElement>(":scope > [data-field-error]")
    ?.remove();
}

function showInvalid(field: Field): void {
  const label = getLabel(field);
  if (!label) return;
  field.style.borderColor = "var(--error)";
  const errorId = `${field.name || "field"}-error`;
  let message = label.querySelector<HTMLElement>(":scope > [data-field-error]");
  if (!message) {
    message = document.createElement("p");
    message.id = errorId;
    message.dataset.fieldError = "";
    message.setAttribute("role", "alert");
    message.style.color = "var(--error)";
    message.style.fontSize = "0.78rem";
    message.style.fontWeight = "500";
    message.style.marginTop = "0.375rem";
    label.appendChild(message);
  }
  message.textContent = messageFor(field);
  field.setAttribute("aria-invalid", "true");
  field.setAttribute("aria-describedby", message.id);
}

function check(field: Field): boolean {
  if (field.disabled || field.closest("[hidden]")) {
    clearInvalid(field);
    return true;
  }
  if (isEffectivelyValid(field)) {
    clearInvalid(field);
    return true;
  }
  showInvalid(field);
  return false;
}

function wireForm(form: HTMLFormElement): void {
  if (form.dataset.fieldValidationWired) return;
  form.dataset.fieldValidationWired = "true";

  const fields = Array.from(
    form.querySelectorAll<Field>("input, select, textarea"),
  );

  for (const field of fields) {
    field.addEventListener("blur", () => check(field));
    field.addEventListener("input", () => {
      if (field.style.borderColor) check(field);
    });
    if (requiresChange(field)) {
      field.addEventListener("change", () => {
        changedFields.add(field);
        check(field);
      });
    }
  }

  form.addEventListener("submit", (event) => {
    let firstInvalid: HTMLElement | null = null;
    for (const field of fields) {
      if (!check(field) && !firstInvalid) firstInvalid = field;
    }
    if (firstInvalid) {
      event.preventDefault();
      firstInvalid.focus();
      firstInvalid.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
}

document.querySelectorAll<HTMLFormElement>("form").forEach(wireForm);

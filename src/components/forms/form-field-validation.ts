// Shared client-side validation for FormField/FormSelect/FormTextarea.
// Imported (not duplicated) from each so bundlers dedupe it to one module
// per page regardless of how many field components render.

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

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
  if (field.validity.valid) {
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

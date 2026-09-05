// Shared client-side submit-busy state for Button.astro's submit variant.
// Imported (not duplicated) from each so bundlers dedupe it to one module
// per page regardless of how many Button instances render.
//
// Progressive enhancement: without this script the form still submits via a
// full page reload exactly as the markup describes; this only adds the
// disabled/relabeled busy state for the common case where JS is available.

function wireForm(form: HTMLFormElement): void {
  if (form.dataset.submitBusyWired) return;
  form.dataset.submitBusyWired = "true";

  form.addEventListener("submit", () => {
    // A blocked submission (client-side validation, etc.) must leave the
    // button interactive so the user can fix the issue and retry.
    if (!form.checkValidity()) return;

    for (const button of form.querySelectorAll<HTMLButtonElement>(
      'button[type="submit"]',
    )) {
      button.disabled = true;
      const busyLabel = button.dataset.busyLabel;
      if (busyLabel) button.textContent = busyLabel;
    }
  });
}

document
  .querySelectorAll<HTMLButtonElement>('button[type="submit"]')
  .forEach((button) => {
    if (button.form) wireForm(button.form);
  });

export {};

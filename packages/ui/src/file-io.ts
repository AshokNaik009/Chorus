/**
 * Browser file download/upload helpers for the `.chorus` bundle (PRD Epic 11,
 * Layer 1). DOM-only, so they work unchanged in BOTH renderers — the web dev
 * harness and the Electron renderer (Chromium) — and need no host seam. Layer 2
 * (`~/.claude` access) is the only part that goes through `SessionArchive`.
 */

/** Trigger a download of `body` as a file named `filename`. */
export function downloadTextFile(
  filename: string,
  body: string,
  mime = 'application/json',
): void {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Open the OS file picker and resolve the chosen file's text, or null if the
 * user cancels. Single-use input element, removed after selection.
 */
export function pickTextFile(
  accept = '.chorus,.json,application/json',
): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (v: { name: string; text: string } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      file
        .text()
        .then((text) => finish({ name: file.name, text }))
        .catch(() => finish(null));
    });
    // If the dialog is dismissed, `change` never fires; window refocus is the
    // most reliable cancel signal across browsers.
    window.addEventListener(
      'focus',
      () => setTimeout(() => finish(null), 500),
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

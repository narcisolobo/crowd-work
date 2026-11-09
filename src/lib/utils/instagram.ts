/** Same rule as the `listings_instagram_check` constraint in the database. */
export const INSTAGRAM_HANDLE_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

/**
 * Turns whatever a person pasted (`@handle`, a profile URL, a bare handle)
 * into a bare handle, or null when it's blank. Doesn't validate: invalid
 * input comes back as-is so the caller can report it.
 */
export function normalizeInstagramHandle(
  raw: string | null | undefined,
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/instagram\.com\/([^/?#\s]+)/i);
  if (urlMatch) return urlMatch[1];

  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

export function isValidInstagramHandle(handle: string): boolean {
  return INSTAGRAM_HANDLE_PATTERN.test(handle);
}

export function instagramProfileUrl(handle: string): string {
  return `https://www.instagram.com/${handle}/`;
}

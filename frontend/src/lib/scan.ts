// Barcode scanners are keyboards that type very fast and finish with Enter. Item codes look like
// "HW-000123": a short prefix of letters/digits, a hyphen, and the number.
export const CODE_PATTERN = /^[A-Za-z0-9]{1,6}-\d{3,}$/;

export function looksLikeCode(text: string): boolean {
  return CODE_PATTERN.test(text.trim());
}

/** Could this be a scanned barcode (an item code, or the original barcode of a product)? No spaces, and
 *  long enough that ordinary words are not mistaken for one. */
export function looksLikeScan(text: string): boolean {
  const t = text.trim();
  return looksLikeCode(t) || (t.length >= 6 && /^[\x21-\x7e]+$/.test(t));
}

/** Time of the latest key press anywhere on the page (set by the scan listener, in the capture phase). */
let lastKeyStamp = 0;
export function noteKey(stamp: number): void {
  lastKeyStamp = stamp;
}

/** Run a one-key shortcut only if no other key follows right behind it. A scan is a burst of keys, and
 *  its letters (an "n", a "/") must not trigger shortcuts; a person pressing one key has no such burst. */
export function afterQuietKey(action: () => void, quietMs = 70): void {
  const stamp = lastKeyStamp;
  setTimeout(() => {
    if (lastKeyStamp === stamp) action();
  }, quietMs);
}

/**
 * Kitchen OS — Whether the app is running from the home screen
 *
 * Only one thing reads this: how loudly to warn about backing up. An installed
 * app looks permanent in a way a browser tab does not, while iPadOS is in fact
 * more willing to clear its storage — and browser storage is the only copy of
 * the kitchen (CLAUDE.md). The reminder deserves stronger words in the case
 * where the risk is higher and looks lower.
 */

/**
 * True when the app was launched from the home screen rather than in Safari.
 *
 * Two checks because iOS has never implemented the standard one. Every other
 * browser answers `display-mode: standalone`; iOS Safari sets a non-standard
 * `navigator.standalone` and reports `browser` for the media query. Reading
 * both is not belt-and-braces, it is the only way to get a right answer on the
 * one device this app targets.
 *
 * Read at render rather than watched. Nothing can change it without a fresh
 * launch — an app does not move between the home screen and Safari while it is
 * open.
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false

  if (window.matchMedia('(display-mode: standalone)').matches) return true

  const legacy = (window.navigator as Navigator & { standalone?: boolean }).standalone
  return legacy === true
}

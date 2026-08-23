/**
 * Kitchen OS — Whether to nag about backing up
 *
 * DECISIONS.md commits to a reminder after 7 days without an export, and calls
 * it "not optional": this iPad holds the only copy of the User's data, so the
 * reminder is the difference between a lost device being annoying and being the
 * end of the kitchen.
 *
 * Pure and clock-free — `today` is passed in.
 */
import type { AppMeta, DateOnly } from '../types/schema'
import { daysUntil } from '../engine'

/** How long a gap is allowed before the banner appears. */
export const BACKUP_REMINDER_DAYS = 7

/**
 * Days since the last successful export, or null if there has never been one.
 *
 * The stored value is a full timestamp; only its date half matters here, so a
 * backup taken last night and one taken this morning both read as today rather
 * than differing by a fraction of a day.
 */
export function daysSinceExport(meta: AppMeta | undefined, today: DateOnly): number | null {
  const lastExportAt = meta?.lastExportAt
  if (lastExportAt === undefined || lastExportAt === '') return null
  const days = daysUntil(lastExportAt.slice(0, 10), today)
  if (days === null) return null
  // Negative means the export is in the past, which is the normal case.
  return Math.max(0, -days)
}

/**
 * Whether to show the reminder.
 *
 * Never having exported counts. That is the most dangerous state there is — no
 * copy exists at all — and it would be perverse for the one case the banner
 * exists for to be the one case it stays quiet.
 */
export function needsBackupReminder(
  meta: AppMeta | undefined,
  today: DateOnly,
  withinDays: number = BACKUP_REMINDER_DAYS,
): boolean {
  const days = daysSinceExport(meta, today)
  if (days === null) return true
  return days >= withinDays
}

/**
 * The line the banner shows. Written to be read as-is.
 *
 * `installed` makes it blunter. An app on the home screen looks as permanent as
 * anything else on the home screen, and iPadOS is in fact more willing to clear
 * an installed web app's storage than a browser's — so the case where the
 * warning reads as least necessary is the case where it is most. It says what
 * would actually happen rather than naming the mechanism, because knowing the
 * word "eviction" does not help anybody export a file.
 *
 * The rhythm is untouched: still seven days, still dismissible for the sitting.
 * Only the wording changes, and only when there is no copy at all.
 */
export function backupReminderMessage(
  meta: AppMeta | undefined,
  today: DateOnly,
  installed = false,
): string {
  const days = daysSinceExport(meta, today)
  if (days === null) {
    return installed
      ? 'You have never exported your kitchen. iPadOS can clear an installed app’s storage on its own, and there is no other copy — everything you have entered would be gone.'
      : 'You have never exported your kitchen. This iPad holds the only copy.'
  }
  return `It has been ${days} days since you last exported. This iPad holds the only copy.`
}

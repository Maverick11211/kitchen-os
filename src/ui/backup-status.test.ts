import { describe, it, expect } from 'vitest'
import type { AppMeta } from '../types/schema'
import { SCHEMA_VERSION } from '../types/schema'
import {
  BACKUP_REMINDER_DAYS,
  backupReminderMessage,
  daysSinceExport,
  needsBackupReminder,
} from './backup-status'

const TODAY = '2026-08-20'

const meta = (lastExportAt?: string): AppMeta => ({
  schemaVersion: SCHEMA_VERSION,
  ...(lastExportAt === undefined ? {} : { lastExportAt }),
})

describe('daysSinceExport', () => {
  it('counts whole days from the date half of the timestamp', () => {
    expect(daysSinceExport(meta('2026-08-20T09:00:00.000Z'), TODAY)).toBe(0)
    expect(daysSinceExport(meta('2026-08-19T23:59:00.000Z'), TODAY)).toBe(1)
    expect(daysSinceExport(meta('2026-08-06T12:00:00.000Z'), TODAY)).toBe(14)
  })

  it('reports never rather than zero when there has been no export', () => {
    expect(daysSinceExport(meta(), TODAY)).toBeNull()
    expect(daysSinceExport(undefined, TODAY)).toBeNull()
  })

  it('does not go negative on a clock that has drifted', () => {
    expect(daysSinceExport(meta('2026-08-25T00:00:00.000Z'), TODAY)).toBe(0)
  })

  it('shrugs off a timestamp it cannot read', () => {
    expect(daysSinceExport(meta('not a date'), TODAY)).toBeNull()
  })
})

describe('needsBackupReminder', () => {
  it('nags loudest at the most dangerous moment — no export at all', () => {
    expect(needsBackupReminder(meta(), TODAY)).toBe(true)
    expect(backupReminderMessage(meta(), TODAY)).toContain('never exported')
  })

  it('stays quiet inside the window', () => {
    expect(needsBackupReminder(meta('2026-08-20T09:00:00.000Z'), TODAY)).toBe(false)
    expect(needsBackupReminder(meta('2026-08-15T09:00:00.000Z'), TODAY)).toBe(false)
  })

  it('speaks up on the seventh day, which is what DECISIONS.md promised', () => {
    expect(BACKUP_REMINDER_DAYS).toBe(7)
    // Six days: still quiet. Seven: not quiet.
    expect(needsBackupReminder(meta('2026-08-14T09:00:00.000Z'), TODAY)).toBe(false)
    expect(needsBackupReminder(meta('2026-08-13T09:00:00.000Z'), TODAY)).toBe(true)
    expect(needsBackupReminder(meta('2026-08-01T09:00:00.000Z'), TODAY)).toBe(true)
  })

  it('says how long it has been', () => {
    expect(backupReminderMessage(meta('2026-08-06T12:00:00.000Z'), TODAY)).toContain('14 days')
  })

  it('takes a different window when asked', () => {
    expect(needsBackupReminder(meta('2026-08-18T09:00:00.000Z'), TODAY, 2)).toBe(true)
    expect(needsBackupReminder(meta('2026-08-18T09:00:00.000Z'), TODAY, 30)).toBe(false)
  })
})

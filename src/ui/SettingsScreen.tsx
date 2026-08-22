/**
 * Kitchen OS — Settings: backup, restore, and what he cooks with
 *
 * Backup comes first and stays first. Browser storage is the only copy of this
 * data (CLAUDE.md), so it is not a settings afterthought — it is the entire
 * safety net, and it keeps the top of the screen.
 *
 * Restoring REPLACES everything. The confirmation says so in those words, and
 * offers to export first, because the one situation where someone taps Restore
 * carelessly is the one where they lose a month of entries.
 *
 * The kit list at the bottom is the one thing here that is not about data
 * safety. It is the same list as the one-off pass on first run (`KitList`), and
 * this is where it is edited afterwards — when a pan is bought or thrown out
 * (Jack, 2026-08-21).
 */
import { useRef, useState } from 'react'
import type { Appliance, ApplianceId, BackupFile, Recipe } from '../types/schema'
import { describeBackupContents, kitQuestions, parseBackupFile, type KitQuestion } from '../engine'
import { db } from '../db/db'
import { setApplianceOwned } from '../db/repo/appliances'
import { backupFilename, readBackupJson, restoreBackup } from '../db/repo/backup'
import { markExported } from '../db/repo/meta'
import { nowIso } from '../lib/clock'
import { KitList, type KitAnswer } from './KitList'

interface PendingRestore {
  readonly backup: BackupFile
  readonly warnings: readonly string[]
  readonly filename: string
}

function formatWhen(timestamp: string | undefined): string {
  if (!timestamp) return 'never'
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return 'never'
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export interface SettingsScreenProps {
  readonly lastExportAt?: string
  readonly recipes: readonly Recipe[]
  readonly appliances: ReadonlyMap<ApplianceId, Appliance>
}

export function SettingsScreen({ lastExportAt, recipes, appliances }: SettingsScreenProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [errors, setErrors] = useState<readonly string[]>([])
  const [pending, setPending] = useState<PendingRestore | null>(null)

  async function exportNow(): Promise<string> {
    const at = nowIso()
    const json = await readBackupJson(db, at)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = backupFilename(at)
    link.click()
    URL.revokeObjectURL(url)
    await markExported(db, at)
    return link.download
  }

  async function handleExport() {
    setBusy(true)
    setErrors([])
    try {
      const name = await exportNow()
      setNotice(`Saved ${name}. Keep it somewhere that is not this iPad.`)
    } catch (error: unknown) {
      setErrors([error instanceof Error ? error.message : 'The export did not finish.'])
    } finally {
      setBusy(false)
    }
  }

  async function handleFileChosen(file: File) {
    setNotice(null)
    setErrors([])
    const result = parseBackupFile(await file.text())

    if (!result.ok) {
      setErrors(result.errors)
      setPending(null)
      return
    }
    setPending({ backup: result.backup, warnings: result.warnings, filename: file.name })
  }

  async function confirmRestore(exportFirst: boolean) {
    if (!pending) return
    setBusy(true)
    setErrors([])
    try {
      if (exportFirst) await exportNow()
      await restoreBackup(db, pending.backup)
      setPending(null)
      setNotice(`Restored from ${pending.filename}.`)
    } catch (error: unknown) {
      setErrors([
        error instanceof Error
          ? `${error.message} Nothing was changed.`
          : 'The restore did not finish. Nothing was changed.',
      ])
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  function cancelRestore() {
    setPending(null)
    setErrors([])
    if (fileInput.current) fileInput.current.value = ''
  }

  async function answerKit(question: KitQuestion, answer: KitAnswer) {
    setErrors([])
    try {
      await setApplianceOwned(db, question.item.id, question.item.name, answer.owned, answer.size)
    } catch (error: unknown) {
      setErrors([error instanceof Error ? error.message : 'That answer was not saved.'])
    }
  }

  const questions = kitQuestions(recipes)

  return (
    <section className="screen">
      <header className="screen-head">
        <h1>Settings</h1>
        <p className="screen-count">Last export: {formatWhen(lastExportAt)}</p>
      </header>

      {notice !== null && <p className="notice">{notice}</p>}
      {errors.length > 0 && (
        <ul className="errors">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      <div className="panel">
        <h2>Save a copy</h2>
        <p>
          This iPad holds the only copy of your kitchen. An export writes it all to a single
          file you can keep in Files, iCloud, or anywhere else.
        </p>
        <button type="button" className="primary" onClick={handleExport} disabled={busy}>
          Export everything
        </button>
      </div>

      <div className="panel">
        <h2>Restore from a file</h2>
        <p>
          Restoring <strong>replaces everything</strong> currently in the app with the contents
          of the file. It does not merge the two.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          disabled={busy || pending !== null}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void handleFileChosen(file)
          }}
        />
      </div>

      {questions.length > 0 && (
        <div className="panel">
          <h2>What do you cook with?</h2>
          <p>
            Recipes needing something you have not got will say so; anything left unanswered
            stays quiet rather than guessing. Sizes are the biggest you own, so a recipe asking
            for a 6 quart pot can tell you it will not fit in a 3. A recipe is never hidden for
            any of this.
          </p>
          <KitList
            questions={questions}
            kit={appliances}
            onAnswer={(question, answer) => void answerKit(question, answer)}
          />
        </div>
      )}

      {pending !== null && (
        <div className="panel panel-warn">
          <h2>Replace everything?</h2>
          <p>
            <strong>{pending.filename}</strong> holds {describeBackupContents(pending.backup)}.
            Everything currently in the app will be thrown away and replaced with it.
          </p>
          {pending.warnings.length > 0 && (
            <ul className="warnings">
              {pending.warnings.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void confirmRestore(true)}
            >
              Export current data first, then replace
            </button>
            <button type="button" disabled={busy} onClick={() => void confirmRestore(false)}>
              Replace without exporting
            </button>
            <button type="button" disabled={busy} onClick={cancelRestore}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

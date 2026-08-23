/**
 * Kitchen OS — Today, kept current
 *
 * `todayIso()` is a function call, so the shell only learned the date once, on
 * the render that happened to mount it. That was harmless for six phases: a
 * browser tab gets closed, and reopening it read the clock again.
 *
 * Phase 8 is what breaks the assumption. An app on a home screen is left open
 * on the counter, and an app left open across midnight goes on labelling
 * yesterday "Today", filing tonight's dinner under the wrong day and judging
 * expiry against a date that has passed.
 *
 * Two things move the date forward here, and both are needed:
 *
 *   1. A timer set for the next local midnight. Handles the app sitting awake.
 *   2. The app becoming visible again. Handles the far more common case on
 *      iPadOS, where a backgrounded app is suspended outright — its timers do
 *      not fire on time, or at all, and the first honest moment to re-read the
 *      clock is when it comes back.
 */
import { useEffect, useState } from 'react'
import type { DateOnly } from '../types/schema'
import { msUntilNextLocalDay, todayIso } from '../lib/clock'

/**
 * A cushion past midnight, in milliseconds.
 *
 * `setTimeout` is allowed to fire a hair early, and firing at 23:59:59.998
 * would read yesterday's date and then reschedule for two milliseconds' time.
 * A second's grace makes that impossible without being visible to anyone.
 */
const PAST_MIDNIGHT_MS = 1000

/**
 * Today's local date, re-read when it changes.
 *
 * Returns the same string on every render within a day, so it stays safe as a
 * `useMemo` dependency — which matters, because the shell re-ranks 150 recipes
 * when it changes.
 */
export function useToday(): DateOnly {
  const [today, setToday] = useState<DateOnly>(() => todayIso())

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    // `setToday` with the same string is a no-op React bails out of, so this
    // can be called as often as it likes without causing a render.
    const refresh = () => {
      setToday(todayIso())
    }

    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        refresh()
        schedule()
      }, msUntilNextLocalDay() + PAST_MIDNIGHT_MS)
    }

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      // Coming back from suspension: the date may have moved and the timer may
      // have been throttled through midnight, so re-read and re-arm together.
      refresh()
      schedule()
    }

    schedule()
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return today
}

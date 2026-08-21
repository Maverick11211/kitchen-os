/**
 * Kitchen OS — The app shell
 *
 * Two panes, landscape: a fixed navigation column on the left, the current
 * screen on the right. Routing is hash-based (`#/inventory`) so that GitHub
 * Pages never has to be told about the app's paths — a reload works with no
 * server configuration and no redirect trick.
 *
 * Nothing here computes anything. The shell reads the kitchen once, hands it to
 * `inventory-view.ts` to be shaped, and passes the result down.
 */
import { useMemo, useState } from 'react'
import { HashRouter, Link, NavLink, Navigate, Route, Routes } from 'react-router'
import type { CanonicalIngredient } from './types/schema'
import { INGREDIENT_CATEGORIES, buildInventoryIndex, buildOntologyIndex } from './engine'
import { todayIso } from './lib/clock'
import {
  CATEGORY_LABELS,
  buildInventoryItems,
  countByCategory,
  itemsNeedingUse,
  type InventoryItem,
} from './ui/inventory-view'
import { AddFlow } from './ui/AddFlow'
import { LogFlow } from './ui/LogFlow'
import { ItemSheet } from './ui/ItemSheet'
import { NutritionScreen } from './ui/NutritionScreen'
import { backupReminderMessage, needsBackupReminder } from './ui/backup-status'
import { CategoryScreen, InventoryScreen } from './ui/InventoryScreen'
import { SettingsScreen } from './ui/SettingsScreen'
import { useKitchen, useMeta, useStartup } from './ui/useKitchenData'
import './App.css'

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'nav-link is-active' : 'nav-link'
}

function Splash({ message, bad = false }: { message: string; bad?: boolean }) {
  return (
    <div className={bad ? 'splash splash-bad' : 'splash'}>
      <p>{message}</p>
    </div>
  )
}

function Sidebar({
  items,
  onAdd,
}: {
  items: readonly InventoryItem[]
  onAdd: () => void
}) {
  const counts = countByCategory(items)
  const useUpCount = itemsNeedingUse(items).length

  return (
    <nav className="pane-left">
      <div className="brand">Kitchen OS</div>

      {/*
        Nutrition is a second top-level area, not another category (Jack,
        2026-08-20). It comes FIRST, above the kitchen and above the add button
        (Jack, 2026-08-21): it is the thing opened several times a day, where
        adding food is the thing done once after a shop. Past days are reached
        with arrows inside the screen, which keeps the rail from growing a
        second list of dates nobody navigates by.

        "Food log" rather than "Today" — the rail entry names the area, and the
        screen's own heading already says which day you are looking at, so
        having both say "Today" was one word doing two jobs.
      */}
      <ul className="nav">
        <li>
          <NavLink to="/today" className={navClass}>
            <span>Food log</span>
          </NavLink>
        </li>
      </ul>

      <div className="nav-heading">Kitchen</div>

      {/*
        The add button belongs to the kitchen, so it lives with it rather than
        floating at the top of the rail where it read as the app's main action.
      */}
      <button type="button" className="add-button" onClick={onAdd}>
        + Add to the kitchen
      </button>

      <ul className="nav">
        <li>
          <NavLink to="/inventory" end className={navClass}>
            <span>Everything</span>
            <span className="count">{items.length}</span>
          </NavLink>
        </li>
        <li>
          <NavLink to="/inventory/expiring" className={navClass}>
            <span>Use up</span>
            <span className={useUpCount > 0 ? 'count count-urgent' : 'count'}>{useUpCount}</span>
          </NavLink>
        </li>
      </ul>

      <div className="nav-heading">Categories</div>
      <ul className="nav nav-scroll">
        {INGREDIENT_CATEGORIES.map((category) => (
          <li key={category}>
            <NavLink to={`/inventory/c/${category}`} className={navClass}>
              <span>{CATEGORY_LABELS[category]}</span>
              <span className="count">{counts.get(category) ?? 0}</span>
            </NavLink>
          </li>
        ))}
      </ul>

      <ul className="nav nav-foot">
        <li>
          <NavLink to="/settings" className={navClass}>
            <span>Backup</span>
          </NavLink>
        </li>
      </ul>
    </nav>
  )
}

function Shell() {
  const data = useKitchen()
  const meta = useMeta()
  const today = todayIso()
  const [adding, setAdding] = useState(false)
  const [logging, setLogging] = useState(false)
  const [selected, setSelected] = useState<CanonicalIngredient | null>(null)
  const [reminderHidden, setReminderHidden] = useState(false)

  const view = useMemo(() => {
    if (!data) return null
    const inventory = buildInventoryIndex(data.products, data.lots)
    return {
      inventory,
      items: buildInventoryItems(buildOntologyIndex(data.ingredients), inventory, today),
    }
  }, [data, today])

  if (!data || view === null) return <Splash message="Opening the kitchen…" />
  const items = view.items

  return (
    <div className="app">
      <Sidebar items={items} onAdd={() => setAdding(true)} />
      <main className="pane-right">
        {/*
          The backup reminder DECISIONS.md calls "not optional". Dismissing it
          hides it for this sitting only — it comes back next time the app is
          opened, because the risk it is warning about does not go away by being
          acknowledged.
        */}
        {meta !== undefined && !reminderHidden && needsBackupReminder(meta, today) && (
          <div className="banner">
            <span>{backupReminderMessage(meta, today)}</span>
            <span className="banner-actions">
              <Link className="banner-link" to="/settings">
                Back up now
              </Link>
              <button type="button" onClick={() => setReminderHidden(true)}>
                Not now
              </button>
            </span>
          </div>
        )}

        <Routes>
          <Route path="/" element={<Navigate to="/today" replace />} />
          <Route
            path="/today"
            element={<NutritionScreen today={today} onLog={() => setLogging(true)} />}
          />
          {/*
            Past days get their own address so a reload lands where you were.
            Today keeps the stable `/today` one, so the rail link stays lit on it
            rather than only matching the date it happens to be.
          */}
          <Route
            path="/day/:day"
            element={<NutritionScreen today={today} onLog={() => setLogging(true)} />}
          />
          <Route
            path="/inventory"
            element={
              <InventoryScreen
                title="Everything"
                items={items}
                emptyNote="Nothing in the kitchen yet."
                onSelect={(item) => setSelected(item.ingredient)}
              />
            }
          />
          <Route
            path="/inventory/expiring"
            element={
              <InventoryScreen
                title="Use up"
                items={itemsNeedingUse(items)}
                emptyNote="Nothing needs using up."
                onSelect={(item) => setSelected(item.ingredient)}
              />
            }
          />
          <Route
            path="/inventory/c/:category"
            element={
              <CategoryScreen items={items} onSelect={(item) => setSelected(item.ingredient)} />
            }
          />
          <Route path="/settings" element={<SettingsScreen lastExportAt={meta?.lastExportAt} />} />
          <Route path="*" element={<Navigate to="/inventory" replace />} />
        </Routes>
      </main>

      {selected !== null && (
        <ItemSheet
          ingredient={selected}
          lots={view.inventory.lotsByCanonical.get(selected.id) ?? []}
          products={view.inventory.productsById}
          today={today}
          onClose={() => setSelected(null)}
        />
      )}

      {adding && (
        <AddFlow
          ingredients={data.ingredients}
          products={data.products}
          today={today}
          onClose={() => setAdding(false)}
        />
      )}

      {logging && (
        <LogFlow
          ingredients={data.ingredients}
          items={items}
          index={view.inventory}
          onClose={() => setLogging(false)}
        />
      )}
    </div>
  )
}

export default function App() {
  const startup = useStartup()

  if (startup.status === 'loading') return <Splash message="Getting the kitchen ready…" />
  if (startup.status === 'failed') {
    return <Splash bad message={`Kitchen OS could not start: ${startup.message}`} />
  }

  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  )
}

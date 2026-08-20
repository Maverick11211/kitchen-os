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
import { useMemo } from 'react'
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router'
import { INGREDIENT_CATEGORIES, buildInventoryIndex, buildOntologyIndex } from './engine'
import { todayIso } from './lib/clock'
import {
  CATEGORY_LABELS,
  buildInventoryItems,
  countByCategory,
  itemsNeedingUse,
  type InventoryItem,
} from './ui/inventory-view'
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

function Sidebar({ items }: { items: readonly InventoryItem[] }) {
  const counts = countByCategory(items)
  const useUpCount = itemsNeedingUse(items).length

  return (
    <nav className="pane-left">
      <div className="brand">Kitchen OS</div>

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

  const items = useMemo(() => {
    if (!data) return []
    return buildInventoryItems(
      buildOntologyIndex(data.ingredients),
      buildInventoryIndex(data.products, data.lots),
      today,
    )
  }, [data, today])

  if (!data) return <Splash message="Opening the kitchen…" />

  return (
    <div className="app">
      <Sidebar items={items} />
      <main className="pane-right">
        <Routes>
          <Route path="/" element={<Navigate to="/inventory" replace />} />
          <Route
            path="/inventory"
            element={
              <InventoryScreen
                title="Everything"
                items={items}
                emptyNote="Nothing in the kitchen yet."
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
              />
            }
          />
          <Route path="/inventory/c/:category" element={<CategoryScreen items={items} />} />
          <Route path="/settings" element={<SettingsScreen lastExportAt={meta?.lastExportAt} />} />
          <Route path="*" element={<Navigate to="/inventory" replace />} />
        </Routes>
      </main>
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

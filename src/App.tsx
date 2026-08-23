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
import type {
  Appliance,
  ApplianceId,
  CanonicalIngredient,
  CookEvent,
  Recipe,
} from './types/schema'
import {
  INGREDIENT_CATEGORIES,
  buildInventoryIndex,
  buildOntologyIndex,
  fullyOwned,
  kitQuestions,
  rankRecipes,
} from './engine'
import { nowIso } from './lib/clock'
import {
  CATEGORY_LABELS,
  buildInventoryItems,
  countByCategory,
  itemsNeedingUse,
  type InventoryItem,
} from './ui/inventory-view'
import { AddFlow } from './ui/AddFlow'
import { CookFlow } from './ui/CookFlow'
import { LogFlow } from './ui/LogFlow'
import { ItemSheet } from './ui/ItemSheet'
import { NutritionScreen } from './ui/NutritionScreen'
import { backupReminderMessage, needsBackupReminder } from './ui/backup-status'
import { CategoryScreen, InventoryScreen } from './ui/InventoryScreen'
import { KitSetup } from './ui/KitList'
import { RecipeDetail } from './ui/RecipeDetail'
import { RecipeForm } from './ui/RecipeForm'
import { RecipeScreen } from './ui/RecipeScreen'
import { SettingsScreen } from './ui/SettingsScreen'
import { isStandalone } from './ui/standalone'
import { useAppUpdate } from './ui/useAppUpdate'
import { useToday } from './ui/useToday'
import {
  useAppliances,
  useKitchen,
  useMeta,
  useOpenCooks,
  useRecipes,
  useStartup,
} from './ui/useKitchenData'
import { db } from './db/db'
import { setApplianceOwned } from './db/repo/appliances'
import { markKitSetUp } from './db/repo/meta'
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
  readyCount,
  onAdd,
}: {
  items: readonly InventoryItem[]
  readyCount: number | null
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
        {/*
          Recipes is the third top-level area, between the log and the kitchen:
          the log is what you ate, recipes is what to cook, the kitchen is what
          is in it. The count is how many you could cook right now with nothing
          missing — the one number this whole app exists to produce, so it earns
          its place in the rail rather than only appearing once you open the
          screen. It is deliberately unfiltered: the rail describes the kitchen,
          not whatever the recipe screen is currently showing.
        */}
        <li>
          <NavLink to="/recipes" className={navClass}>
            <span>Recipes</span>
            {readyCount !== null && <span className="count">{readyCount}</span>}
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
            {/*
              Renamed from "Backup" when the appliance question moved in
              (2026-08-21). Backup is still the first thing on that screen and
              the reminder banner still points straight at it — but the rail
              entry now has to name a screen that does two things.
            */}
            <span>Settings</span>
          </NavLink>
        </li>
      </ul>
    </nav>
  )
}

/**
 * Stable empty map for the appliance lookup while it is still loading.
 *
 * A fresh `new Map()` on every render would change the identity of a `useMemo`
 * dependency and re-rank 150 recipes for nothing.
 */
const NO_APPLIANCES: ReadonlyMap<ApplianceId, Appliance> = new Map()

/** Stable empty list of batches while the query is still loading. Same reason. */
const NO_COOKS: readonly CookEvent[] = []

function Shell() {
  const data = useKitchen()
  const recipes = useRecipes()
  const appliances = useAppliances()
  const openCooks = useOpenCooks()
  const meta = useMeta()
  /**
   * Re-read at local midnight and whenever the app comes back to the
   * foreground, rather than once when the shell mounts. An installed app is
   * left open for days; see `useToday`.
   */
  const today = useToday()
  const update = useAppUpdate()
  const [adding, setAdding] = useState(false)
  const [logging, setLogging] = useState(false)
  const [selected, setSelected] = useState<CanonicalIngredient | null>(null)
  const [reminderHidden, setReminderHidden] = useState(false)
  const [kitHidden, setKitHidden] = useState(false)
  /** null = closed, 'new' = adding, a Recipe = editing that one. */
  const [recipeForm, setRecipeForm] = useState<'new' | Recipe | null>(null)
  /** The recipe being cooked, or null. Its own state: you can cook a recipe you are also editing. */
  const [cooking, setCooking] = useState<Recipe | null>(null)

  const view = useMemo(() => {
    if (!data) return null
    const inventory = buildInventoryIndex(data.products, data.lots)
    const ontology = buildOntologyIndex(data.ingredients)
    return {
      inventory,
      ontology,
      items: buildInventoryItems(ontology, inventory, today),
    }
  }, [data, today])

  /**
   * How many recipes need nothing bought — the rail badge.
   *
   * Ranked here rather than read off the recipe screen because the rail is
   * visible from everywhere, and because the badge is deliberately unfiltered:
   * it answers "what could I cook right now", not "what does the list on screen
   * currently show". Null until the recipes have loaded, so the badge appears
   * with a real number rather than flashing a zero.
   */
  const readyCount = useMemo(() => {
    if (view === null || recipes === undefined) return null
    return fullyOwned(rankRecipes(recipes, view.inventory, view.ontology, { today })).length
  }, [view, recipes, today])

  /**
   * The one-off kit pass, shown when the app has never been told what he cooks
   * with (Jack, 2026-08-21). "Not now" hides it for this sitting only and
   * stamps nothing, so an app that has never been answered keeps asking rather
   * than quietly deciding it knows.
   */
  const kitQuestionList = useMemo(() => (recipes === undefined ? [] : kitQuestions(recipes)), [recipes])
  const askAboutKit =
    !kitHidden &&
    meta !== undefined &&
    meta.kitSetUpAt === undefined &&
    appliances !== undefined &&
    kitQuestionList.length > 0

  if (!data || view === null) return <Splash message="Opening the kitchen…" />
  const items = view.items

  return (
    <div className="app">
      <Sidebar items={items} readyCount={readyCount} onAdd={() => setAdding(true)} />
      <main className="pane-right">
        {/*
          A new version has downloaded and is waiting. Nothing swaps until this
          is tapped — see `useAppUpdate` for why the waiting is deliberate.

          Above the backup reminder because it is the rarer of the two and
          because it is transient: it appears, gets tapped, and is gone, where
          the backup banner is a standing condition. No "later" button, and it
          is not dismissible: it costs one line and one tap, and an update the
          User has waved away is an update they will never think about again.
        */}
        {update.ready && (
          <div className="banner banner-update">
            <span>A new version of Kitchen OS is ready.</span>
            <span className="banner-actions">
              <button type="button" onClick={update.apply}>
                Reload
              </button>
            </span>
          </div>
        )}

        {/*
          The backup reminder DECISIONS.md calls "not optional". Dismissing it
          hides it for this sitting only — it comes back next time the app is
          opened, because the risk it is warning about does not go away by being
          acknowledged.

          Blunter wording once the app is installed and has never been exported:
          iPadOS can clear an installed app's storage on its own, and a home
          screen icon looks permanent in a way that makes the warning read as
          less urgent exactly when it is more.
        */}
        {meta !== undefined && !reminderHidden && needsBackupReminder(meta, today) && (
          <div className="banner">
            <span>{backupReminderMessage(meta, today, isStandalone())}</span>
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
            element={
              <NutritionScreen
                today={today}
                onLog={() => setLogging(true)}
                products={view.inventory.productsById}
              />
            }
          />
          {/*
            Past days get their own address so a reload lands where you were.
            Today keeps the stable `/today` one, so the rail link stays lit on it
            rather than only matching the date it happens to be.
          */}
          <Route
            path="/day/:day"
            element={
              <NutritionScreen
                today={today}
                onLog={() => setLogging(true)}
                products={view.inventory.productsById}
              />
            }
          />
          <Route
            path="/recipes"
            element={
              recipes === undefined ? (
                <Splash message="Reading the recipes…" />
              ) : (
                <RecipeScreen
                  recipes={recipes}
                  inventory={view.inventory}
                  ontology={view.ontology}
                  appliances={appliances ?? NO_APPLIANCES}
                  today={today}
                  onAdd={() => setRecipeForm('new')}
                />
              )
            }
          />
          <Route
            path="/recipes/:recipeId"
            element={
              recipes === undefined ? (
                <Splash message="Reading the recipes…" />
              ) : (
                <RecipeDetail
                  recipes={recipes}
                  inventory={view.inventory}
                  ontology={view.ontology}
                  appliances={appliances ?? NO_APPLIANCES}
                  today={today}
                  onEdit={(recipe) => setRecipeForm(recipe)}
                  onCook={(recipe) => setCooking(recipe)}
                />
              )
            }
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
          <Route
            path="/settings"
            element={
              <SettingsScreen
                lastExportAt={meta?.lastExportAt}
                recipes={recipes ?? []}
                appliances={appliances ?? NO_APPLIANCES}
              />
            }
          />
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

      {recipeForm !== null && recipes !== undefined && (
        <RecipeForm
          ingredients={data.ingredients}
          recipes={recipes}
          editing={recipeForm === 'new' ? undefined : recipeForm}
          onClose={() => setRecipeForm(null)}
          onSaved={() => setRecipeForm(null)}
        />
      )}

      {askAboutKit && appliances !== undefined && (
        <KitSetup
          questions={kitQuestionList}
          kit={appliances}
          onAnswer={(question, answer) => {
            void setApplianceOwned(
              db,
              question.item.id,
              question.item.name,
              answer.owned,
              answer.size,
            )
          }}
          onDone={() => {
            void markKitSetUp(db, nowIso())
            setKitHidden(true)
          }}
          onLater={() => setKitHidden(true)}
        />
      )}

      {cooking !== null && (
        <CookFlow
          recipe={cooking}
          inventory={view.inventory}
          ontology={view.ontology}
          today={today}
          onClose={() => setCooking(null)}
        />
      )}

      {logging && (
        <LogFlow
          ingredients={data.ingredients}
          items={items}
          cooks={openCooks ?? NO_COOKS}
          index={view.inventory}
          today={today}
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

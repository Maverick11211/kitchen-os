/**
 * Kitchen OS — Engine
 *
 * Pure logic. No React, no Dexie, no clock, no randomness: every function here
 * takes what it needs as an argument and returns a value. Anything time-
 * dependent (`now`, `today`) is passed in by the caller, which is what makes
 * the whole engine reproducible in tests.
 *
 * UI components import from here and never do unit conversion or macro math of
 * their own (CLAUDE.md).
 *
 *   units       — grams <-> any Unit, driven by the ontology's conversion fields
 *   ontology    — canonical ingredient lookup
 *   inventory   — FEFO deduction, availability, expiry
 *   macros      — MacroSet arithmetic and batch/portion totals
 *   ownership   — "what can I cook right now?" and recipe ranking
 *   ingredients — validating and creating a User-added canonical ingredient
 *   seed-merge  — folding a redeployed ontology.json into existing data
 *   backup      — assembling and checking an export/import file
 */

export {
  CUP_ML,
  FLOZ_ML,
  LB_G,
  OZ_G,
  TBSP_PER_CUP,
  TSP_PER_CUP,
  canConvert,
  convertibleUnits,
  fromGrams,
  gramsPerMl,
  isMassUnit,
  isVolumeUnit,
  toGrams,
} from './units'
export type {
  ConversionFailure,
  ConversionFailureReason,
  FromGramsResult,
  ToGramsResult,
} from './units'

export { buildOntologyIndex, findIngredient, isTracked } from './ontology'
export type { OntologyIndex } from './ontology'

export {
  GRAM_EPSILON,
  applyDeductions,
  availableGramsFor,
  availableLotsFor,
  batchMacrosForDeductions,
  buildInventoryIndex,
  compareLotsFefo,
  daysUntil,
  expiringSoonLotsFor,
  isExpiringSoon,
  isLotAvailable,
  macroLinesForDeductions,
  ownsAny,
  planDeduction,
  planRecipeDeduction,
  revertDeductions,
} from './inventory'
export type {
  DeductionPlan,
  InventoryIndex,
  RecipeDeductionPlan,
  Shortfall,
} from './inventory'

export {
  MACRO_KEYS,
  ZERO_MACROS,
  addMacros,
  fractionOfMacros,
  isZeroMacros,
  macrosForLines,
  multiplyMacros,
  roundMacros,
  scaleMacros,
  subtractMacros,
  sumMacros,
  totalMacros,
} from './macros'
export type { MacroLine } from './macros'

export {
  DEFAULT_EXPIRING_SOON_DAYS,
  LOW_QUANTITY_THRESHOLD,
  availableGramsForLine,
  compareByOwnership,
  evaluateOwnership,
  fullyOwned,
  missingOneTier,
  rankRecipes,
} from './ownership'
export type {
  IngredientOwnership,
  OwnershipOptions,
  RankingOptions,
  RecipeOwnership,
  RecipeSort,
} from './ownership'

export {
  INGREDIENT_CATEGORIES,
  TRACK_BY_MODES,
  createUserIngredient,
  generateIngredientId,
  isUserAdded,
  normaliseAliases,
  slugifyIngredientId,
  validateIngredientDraft,
} from './ingredients'
export type {
  CanonicalIngredientDraft,
  CreateIngredientResult,
  IssueField,
  ValidationIssue,
  ValidationResult,
} from './ingredients'

export { describeSeedMerge, mergeSeedOntology, needsSeedMerge } from './seed-merge'
export type { SeedMergeResult } from './seed-merge'

export {
  BACKUP_COLLECTIONS,
  buildBackupFile,
  describeBackupContents,
  parseBackupFile,
  validateBackupFile,
} from './backup'
export type { BackupCollection, BackupContents, BackupValidation } from './backup'

import { SEED_CATALOG_HISTORY, SEED_ROWS } from './seed'
import type { CatalogHistoryRecord, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'lake-govern-config:entries'
// 目录动作的历史版本流水，与业务条目分开存放、只追加不改写。
const HISTORY_KEY = 'lake-govern-config:catalog-history'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null
let historyCache: CatalogHistoryRecord[] | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function listHistory(): CatalogHistoryRecord[] {
  if (historyCache === null) {
    historyCache = readHistory()
  }
  return historyCache
}

function readHistory(): CatalogHistoryRecord[] {
  const fallback = clone(SEED_CATALOG_HISTORY)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(HISTORY_KEY)
  if (!raw) {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    return JSON.parse(raw) as CatalogHistoryRecord[]
  } catch {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(fallback))
    return fallback
  }
}

export function appendHistory(records: CatalogHistoryRecord[]): void {
  historyCache = [...listHistory(), ...records]
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(historyCache))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function historyStorageKey(): string {
  return HISTORY_KEY
}

/**
 * 丢弃内存缓存并从 localStorage 重新装载：
 * 用于多标签页（另一个管理员在别处提交）或外部存储变更后的重新对齐，
 * 避免页面一直展示旧档。
 */
export function reloadFromStorage(): void {
  cache = readStorage()
  historyCache = readHistory()
}

// 多标签页并发：另一个管理员在别的标签页提交后，本标签页立刻丢弃旧缓存，
// 后续动作基于最新修订号做乐观锁判断，防止两边各写各的旧档。
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === HISTORY_KEY) {
      reloadFromStorage()
    }
  })
}

/**
 * 一次跨模块（目录 + 元数据 + 历史版本）的原子提交：
 * 先在内存里把变更全部算完，最后一次性落盘；
 * 落盘任何一步失败都恢复到事务前的内存快照，并把错误继续抛给上层，
 * 由上层丢弃本次临时审核结论，不能留下半条结果。
 */
export type TransactionDraft = {
  rows: Record<string, EntryRow[]>
  history: CatalogHistoryRecord[]
}

export function beginTransaction(): TransactionDraft {
  return {
    rows: clone(allRows()),
    history: clone(listHistory()),
  }
}

export function commitTransaction(draft: TransactionDraft): void {
  const snapshot = {
    cache: cache === null ? null : clone(cache),
    historyCache: historyCache === null ? null : clone(historyCache),
    entriesRaw:
      typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(STORAGE_KEY)
        : null,
    historyRaw:
      typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(HISTORY_KEY)
        : null,
  }
  try {
    cache = draft.rows
    historyCache = draft.history
    if (typeof window !== 'undefined' && window.localStorage) {
      // 两步写入：第二步失败时第一步也要回滚，保证目录、元数据、历史版本同生共死。
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft.rows))
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(draft.history))
    }
  } catch (error) {
    cache = snapshot.cache
    historyCache = snapshot.historyCache
    if (typeof window !== 'undefined' && window.localStorage) {
      if (snapshot.entriesRaw === null) {
        window.localStorage.removeItem(STORAGE_KEY)
      } else {
        window.localStorage.setItem(STORAGE_KEY, snapshot.entriesRaw)
      }
      if (snapshot.historyRaw === null) {
        window.localStorage.removeItem(HISTORY_KEY)
      } else {
        window.localStorage.setItem(HISTORY_KEY, snapshot.historyRaw)
      }
    }
    throw error
  }
}

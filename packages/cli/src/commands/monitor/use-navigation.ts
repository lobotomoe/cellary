/** View stack navigation hook for the right panel */

import { useCallback, useState } from 'react'
import type { ViewId, ViewParams, ViewStackEntry } from './navigation.js'

export interface Navigation {
  /** Current view (top of stack) */
  readonly current: ViewStackEntry
  /** Navigate deeper into a view */
  readonly push: (id: ViewId, params?: ViewParams) => void
  /** Go back one level (pop stack). Returns false if already at root. */
  readonly pop: () => boolean
  /** Reset to root menu */
  readonly reset: () => void
  /** Stack depth (1 = root) */
  readonly depth: number
}

const ROOT: ViewStackEntry = { id: 'main-menu' }

export function useNavigation(): Navigation {
  const [stack, setStack] = useState<readonly ViewStackEntry[]>([ROOT])

  const current = stack[stack.length - 1] ?? ROOT

  const push = useCallback((id: ViewId, params?: ViewParams) => {
    setStack((prev) => [...prev, params !== undefined ? { id, params } : { id }])
  }, [])

  const pop = useCallback((): boolean => {
    let popped = false
    setStack((prev) => {
      if (prev.length <= 1) return prev
      popped = true
      return prev.slice(0, -1)
    })
    return popped
  }, [])

  const reset = useCallback(() => {
    setStack([ROOT])
  }, [])

  return { current, push, pop, reset, depth: stack.length }
}

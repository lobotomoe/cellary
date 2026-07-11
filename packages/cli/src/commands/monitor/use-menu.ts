/** Keyboard-driven menu selection hook */

import { useInput } from 'ink'
import { useCallback, useState } from 'react'

interface UseMenuOptions {
  /** Number of items in the list */
  readonly itemCount: number
  /** Called when Enter is pressed on selected index */
  readonly onSelect: (index: number) => void
  /** Whether this menu is active (receives input) */
  readonly active: boolean
}

export interface MenuState {
  readonly selectedIndex: number
  readonly setSelectedIndex: (index: number) => void
}

export function useMenu({ itemCount, onSelect, active }: UseMenuOptions): MenuState {
  const [selectedIndex, setSelectedIndex] = useState(0)

  const clampedIndex = itemCount > 0 ? Math.min(selectedIndex, itemCount - 1) : 0

  useInput(
    (input, key) => {
      if (itemCount === 0) return

      if (key.upArrow || input === 'k') {
        setSelectedIndex((i) => (i > 0 ? i - 1 : itemCount - 1))
        return
      }
      if (key.downArrow || input === 'j') {
        setSelectedIndex((i) => (i < itemCount - 1 ? i + 1 : 0))
        return
      }
      if (key.return) {
        onSelect(clampedIndex)
      }
    },
    { isActive: active },
  )

  const safeSetter = useCallback(
    (index: number) => {
      setSelectedIndex(Math.max(0, Math.min(index, itemCount - 1)))
    },
    [itemCount],
  )

  return { selectedIndex: clampedIndex, setSelectedIndex: safeSetter }
}

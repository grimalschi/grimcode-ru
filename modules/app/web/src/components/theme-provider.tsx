import { isThemePreference, type ThemePreference } from "@/theme"
import * as React from "react"

/**
 * Owns the application's theme.
 *
 * `system` is resolved here rather than left to CSS: Tailwind's `dark:` needs a concrete state on the
 * document. The result goes to `data-theme`, the `dark` class the components expect, and React
 * context so the theme switch and notifications stay in sync.
 */
interface ThemeContextValue {
  /** What the person picked, `system` included — unlike `applied`, which is what is on screen. */
  preference: ThemePreference
  applied: "light" | "dark"
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)
const STORAGE_KEY = "template.app.theme"

export function useTheme(): ThemeContextValue {
  const value = React.useContext(ThemeContext)
  if (!value) throw new Error("useTheme must be used inside a ThemeProvider")
  return value
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setStored] = React.useState<ThemePreference>(readStored)

  const [systemIsDark, setSystemIsDark] = React.useState(prefersDark)

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return

    const query = window.matchMedia("(prefers-color-scheme: dark)")
    const update = () => setSystemIsDark(query.matches)
    query.addEventListener("change", update)
    update()

    return () => query.removeEventListener("change", update)
  }, [])

  const applied: "light" | "dark" =
    preference === "system" ? (systemIsDark ? "dark" : "light") : preference

  React.useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = applied
    root.classList.toggle("dark", applied === "dark")
    root.style.colorScheme = applied
  }, [applied])

  const setPreference = React.useCallback(
    (next: ThemePreference) => {
      setStored(next)
      try {
        window.localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // A browser with storage disabled still gets a working theme for this session.
      }
    },
    [],
  )

  const value = React.useMemo(
    () => ({ preference, applied, setPreference }),
    [preference, applied, setPreference],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

function readStored(): ThemePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (isThemePreference(value)) return value
  } catch {
    // Fall through to the default.
  }
  return "system"
}

function prefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

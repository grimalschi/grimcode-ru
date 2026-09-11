import { isThemePreference, type ThemePreference } from "@/theme"
import * as React from "react"

/** The central shell owns the theme and passes it to embedded module admins. */
interface ThemeContextValue {
  /** What the person picked, `system` included — unlike `applied`, which is what is on screen. */
  preference: ThemePreference
  applied: "light" | "dark"
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const value = React.useContext(ThemeContext)
  if (!value) throw new Error("useTheme must be used inside an AdminThemeProvider")
  return value
}

const storageKey = "template.admin.theme"

export function AdminThemeProvider({ children }: { children: React.ReactNode }) {
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
        window.localStorage.setItem(storageKey, next)
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
    const value = window.localStorage.getItem(storageKey)
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

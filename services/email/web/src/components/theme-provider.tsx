import { isThemePreference, type ThemePreference } from "@template/shared/browser"
import * as React from "react"

/**
 * Owns the theme for one admin surface.
 *
 * `system` is resolved here rather than left to CSS, because Tailwind's `dark:` variant needs a
 * concrete state on the document. The resolved theme is written to `data-theme` — the same
 * attribute the non-React admin kit and the Adminer wrapper use — and mirrored to the `dark`
 * class that the shadcn components expect.
 *
 * A service admin runs inside the shell's iframe and does not own the choice: it applies whatever
 * the shell sends and hides its own switch. `controlled` expresses that.
 */
interface ThemeContextValue {
  /** What the user picked, including `system`. */
  preference: ThemePreference
  /** What is actually on screen. */
  applied: "light" | "dark"
  setPreference: (preference: ThemePreference) => void
  /** True when an outer surface owns the theme, so this one must not offer a switch. */
  controlled: boolean
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const value = React.useContext(ThemeContext)
  if (!value) throw new Error("useTheme must be used inside an AdminThemeProvider")
  return value
}

export interface AdminThemeProviderProps {
  children: React.ReactNode
  /** Where the choice is remembered. Each admin surface uses its own key. */
  storageKey?: string
  /**
   * Set when an outer surface owns the theme. The provider then applies `theme` as given and
   * remembers nothing.
   */
  controlledTheme?: ThemePreference | null
}

export function AdminThemeProvider({
  children,
  storageKey = "template.admin.theme",
  controlledTheme = null,
}: AdminThemeProviderProps) {
  const controlled = controlledTheme !== null

  const [stored, setStored] = React.useState<ThemePreference>(() => readStored(storageKey))
  const preference = controlled ? controlledTheme : stored

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
      if (controlled) return
      setStored(next)
      try {
        window.localStorage.setItem(storageKey, next)
      } catch {
        // A browser with storage disabled still gets a working theme for this session.
      }
    },
    [controlled, storageKey],
  )

  const value = React.useMemo(
    () => ({ preference, applied, setPreference, controlled }),
    [preference, applied, setPreference, controlled],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

function readStored(storageKey: string): ThemePreference {
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

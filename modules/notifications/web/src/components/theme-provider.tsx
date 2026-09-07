import { isThemePreference, type ThemePreference } from "@template/shared/browser"
import * as React from "react"

/**
 * Owns the theme for one admin surface.
 *
 * `system` is resolved here rather than left to CSS: Tailwind's `dark:` needs a concrete state on the
 * document. The result goes to `data-theme` — what the non-React admin kit and every embedded frame
 * read — and to the `dark` class the shadcn components expect. A service admin inside the shell's
 * frame owns nothing: it applies what the shell sends and hides its switch, which is `controlled`.
 */
interface ThemeContextValue {
  /** What the person picked, `system` included — unlike `applied`, which is what is on screen. */
  preference: ThemePreference
  applied: "light" | "dark"
  setPreference: (preference: ThemePreference) => void
  /** An outer surface owns the theme, so this one must not offer a switch. */
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
  /** Each admin surface remembers its choice under its own key. */
  storageKey?: string
  /** Set by an outer surface: the provider then applies it as given and remembers nothing. */
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

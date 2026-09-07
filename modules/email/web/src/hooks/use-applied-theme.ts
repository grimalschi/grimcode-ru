import * as React from "react"

/**
 * The theme currently applied to the document — `light` or `dark`, never `system`.
 *
 * It reads the document rather than a React state, so a component is correct even when the theme
 * was applied by the Admin shell through the frame protocol instead of by this application.
 */
export function useAppliedTheme(): "light" | "dark" {
  const [theme, setTheme] = React.useState<"light" | "dark">(() => readTheme())

  React.useEffect(() => {
    const root = document.documentElement
    const update = () => setTheme(readTheme())

    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] })
    update()

    return () => observer.disconnect()
  }, [])

  return theme
}

function readTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light"
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light"
}

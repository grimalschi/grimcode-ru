import {
  ADMIN_FRAME_MESSAGES,
  isThemePreference,
  normalizeServicePath,
  type AdminFrameMessage,
  type ThemePreference,
} from "@template/shared/browser"
import * as React from "react"

/**
 * Iframe side of the frame protocol.
 *
 * A service admin is normally embedded in the central Admin shell, but its protected URL also
 * works when opened directly. `embedded` tells the two apart: standing alone, the service admin
 * owns its own theme and shows its own switch.
 */
export interface FrameChildOptions {
  /** Current service-relative path, from this application's router. */
  path: string
  /** Called when the shell asks for a different path. */
  onNavigate: (path: string) => void
}

export interface FrameChildState {
  embedded: boolean
  /** Theme sent by the shell, or `null` when this surface owns its own. */
  theme: ThemePreference | null
}

export function useFrameChild({ path, onNavigate }: FrameChildOptions): FrameChildState {
  const [embedded] = React.useState(() => typeof window !== "undefined" && window.parent !== window)
  const [theme, setTheme] = React.useState<ThemePreference | null>(null)

  const post = React.useCallback(
    (message: AdminFrameMessage) => {
      if (!embedded) return
      window.parent.postMessage(message, window.location.origin)
    },
    [embedded],
  )

  React.useEffect(() => {
    if (!embedded) return

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.source !== window.parent) return

      const message = event.data as AdminFrameMessage | null
      if (!message || typeof message !== "object") return

      if (message.type === ADMIN_FRAME_MESSAGES.theme && isThemePreference(message.theme)) {
        setTheme(message.theme)
        return
      }

      if (message.type === ADMIN_FRAME_MESSAGES.navigate) {
        onNavigate(normalizeServicePath(message.path))
      }
    }

    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [embedded, onNavigate])

  // Announced once the application is mounted, so the shell can end its loading state even if the
  // iframe's `load` event fired earlier.
  React.useEffect(() => {
    post({ type: ADMIN_FRAME_MESSAGES.ready })
  }, [post])

  React.useEffect(() => {
    post({ type: ADMIN_FRAME_MESSAGES.path, path: normalizeServicePath(path) })
  }, [path, post])

  return { embedded, theme }
}

import {
  ADMIN_FRAME_MESSAGES,
  normalizeServicePath,
  type AdminFrameMessage,
  type ThemePreference,
} from "@template/shared/browser"
import * as React from "react"

/**
 * Shell side of the frame protocol.
 *
 * The shell owns the theme and the service-relative route; the iframe owns everything inside it.
 * Messages are only ever accepted from this window's own origin and from this iframe's window.
 */
export interface ServiceFrameOptions {
  frame: React.RefObject<HTMLIFrameElement | null>
  /** Service-relative path the shell wants the iframe to show. */
  path: string
  theme: ThemePreference
  /** Called when the iframe reports where it actually is, so the shell can update its URL. */
  onPathChange: (path: string) => void
}

export interface ServiceFrameState {
  loading: boolean
  /** Last path the iframe reported; `null` until it reports one. */
  childPath: string | null
}

export function useServiceFrame({
  frame,
  path,
  theme,
  onPathChange,
}: ServiceFrameOptions): ServiceFrameState {
  const [loading, setLoading] = React.useState(true)
  const [childPath, setChildPath] = React.useState<string | null>(null)

  // Kept in a ref as well, so the load handler can read the current value without being torn down
  // and rebuilt on every theme change.
  const themeRef = React.useRef(theme)
  themeRef.current = theme

  const post = React.useCallback(
    (message: AdminFrameMessage) => {
      frame.current?.contentWindow?.postMessage(message, window.location.origin)
    },
    [frame],
  )

  React.useEffect(() => {
    const element = frame.current
    if (!element) return

    /**
     * Every load re-sends the theme and ends the loading state — but never the shell's path.
     * A load can be the iframe's own internal navigation, and replaying a stale parent path would
     * silently cancel it.
     */
    const handleLoad = () => {
      post({ type: ADMIN_FRAME_MESSAGES.theme, theme: themeRef.current })
      setLoading(false)
    }

    element.addEventListener("load", handleLoad)
    return () => element.removeEventListener("load", handleLoad)
  }, [frame, post])

  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.source !== frame.current?.contentWindow) return

      const message = event.data as AdminFrameMessage | null
      if (!message || typeof message !== "object") return

      if (message.type === ADMIN_FRAME_MESSAGES.ready) {
        setLoading(false)
        post({ type: ADMIN_FRAME_MESSAGES.theme, theme: themeRef.current })
        return
      }

      if (message.type === ADMIN_FRAME_MESSAGES.path) {
        const reported = normalizeServicePath(message.path)
        setChildPath(reported)
        onPathChange(reported)
      }
    }

    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [frame, onPathChange, post])

  React.useEffect(() => {
    post({ type: ADMIN_FRAME_MESSAGES.theme, theme })
  }, [post, theme])

  React.useEffect(() => {
    const wanted = normalizeServicePath(path)
    // Only a real difference is sent. Echoing back the path the iframe just reported would fight
    // with navigation that started inside the iframe.
    if (childPath === null || wanted === childPath) return
    post({ type: ADMIN_FRAME_MESSAGES.navigate, path: wanted })
  }, [childPath, path, post])

  return { loading, childPath }
}

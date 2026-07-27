import { THEME_PREFERENCES, type ThemePreference } from "@template/shared/browser"
import { MoonIcon, SunIcon, SunMoonIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useTheme } from "@/components/theme-provider"

const LABELS: Record<ThemePreference, string> = {
  light: "Светлая",
  dark: "Тёмная",
  system: "Как в системе",
}

const ICONS: Record<ThemePreference, typeof SunIcon> = {
  light: SunIcon,
  dark: MoonIcon,
  // Sun and moon together: the option is about following whichever the system is on, not about
  // the device it runs on.
  system: SunMoonIcon,
}

/**
 * Light, dark and system.
 *
 * Renders nothing when an outer surface owns the theme: a service admin embedded in the shell
 * must not offer a second, disagreeing switch.
 */
export function ThemeToggle() {
  const { preference, setPreference, controlled } = useTheme()
  if (controlled) return null

  const Icon = ICONS[preference]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* size-7 to sit on the same line as the other icons down the sidebar's right edge. */}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Тема: ${LABELS[preference]}`}
        >
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_PREFERENCES.map((option) => {
          const OptionIcon = ICONS[option]
          return (
            <DropdownMenuItem
              key={option}
              onSelect={() => setPreference(option)}
              data-active={option === preference}
              className="data-[active=true]:bg-accent"
            >
              <OptionIcon />
              {LABELS[option]}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

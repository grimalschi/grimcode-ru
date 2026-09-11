import { Link, useMatchRoute } from '@tanstack/react-router';
import { DynamicIcon } from 'lucide-react/dynamic';
import {
  AppWindowIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  LogOutIcon,
  ScrollTextIcon,
  ShieldIcon,
} from 'lucide-react';

import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { adminModules } from '@/modules';
import type { AdminSession } from '@/session';

/** Opens the public site and app in separate tabs. */
const PRODUCT = [
  { href: '/', label: 'Открыть сайт' },
  { href: '/app/', label: 'Открыть приложение' },
];

/**
 * Sidebar of the panel: the product, the module admins, and the panel's own sections.
 *
 * Only the modules the server returned are listed. That is presentation, not protection: the
 * protected URL of a hidden module passes the very same Router check.
 */
export function AppSidebar({ session, onLogout }: { session: AdminSession; onLogout: () => void }) {
  const catalogue = adminModules(session.catalogue);
  // Which section is open, so the sidebar keeps saying where you are. Asked of the router rather
  // than compared against the address by hand: the panel is mounted under a base path, and the
  // module pages carry the module-relative route in the hash.
  const matchRoute = useMatchRoute();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-0">
        <div className="flex h-14 shrink-0 items-center gap-2 px-2">
          <SidebarTrigger aria-label="Переключить меню" className="size-10 md:size-8" />
          <span className="truncate font-semibold group-data-[collapsible=icon]:hidden">Admin</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {PRODUCT.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild tooltip={item.label} className="text-muted-foreground">
                    <a href={item.href} target="_blank" rel="noreferrer">
                      <ExternalLinkIcon />
                      {/* Truncates rather than wraps: the width animates, and a second line
                          appears for the length of the animation otherwise. */}
                      <span className="flex-1 truncate">{item.label}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Модули</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {catalogue.map((module) => {
                return (
                  <SidebarMenuItem key={module.id}>
                    <SidebarMenuButton
                      asChild
                      tooltip={module.label}
                      isActive={Boolean(
                        matchRoute({ to: '/module/$module', params: { module: module.id } }),
                      )}
                    >
                      {/* The hash carries the module-relative path, so a deep link survives a
                          reload and the browser's back button. */}
                      <Link to="/module/$module" params={{ module: module.id }} hash="/">
                        <DynamicIcon name={module.icon} fallback={() => <AppWindowIcon />} />
                        <span>{module.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {session.role === 'owner' ? (
          <SidebarGroup>
            <SidebarGroupLabel>Админка</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip="Администраторы"
                    isActive={Boolean(matchRoute({ to: '/administrators' }))}
                  >
                    <Link to="/administrators">
                      <ShieldIcon />
                      <span>Администраторы</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip="Журнал"
                    isActive={Boolean(matchRoute({ to: '/audit' }))}
                  >
                    <Link to="/audit">
                      <ScrollTextIcon />
                      <span>Журнал</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {/*
                  A section of the panel, not a module: it reads every module's data at once,
                  which is why it lives here with the owner's other tools.
                */}
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip="База данных"
                    isActive={Boolean(matchRoute({ to: '/database' }))}
                  >
                    <Link to="/database">
                      <DatabaseIcon />
                      <span>База данных</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center justify-between gap-2 pr-0.5 pl-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:px-0">
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <p className="truncate text-sm font-medium">{session.email}</p>
            <p className="text-muted-foreground text-xs capitalize">{session.role}</p>
          </div>
          {/* Collapsed, the sidebar is narrower than two buttons side by side, so they stack. */}
          <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onLogout}
              aria-label="Выйти"
            >
              <LogOutIcon />
            </Button>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

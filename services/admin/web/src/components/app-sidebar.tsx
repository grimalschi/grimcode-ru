import type { AdminServiceId } from '@template/contracts';
import { Link, useMatchRoute } from '@tanstack/react-router';
import {
  BellIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  GlobeIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MailIcon,
  ScrollTextIcon,
  ShieldIcon,
  UsersIcon,
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
import { ADMIN_SERVICES, DATABASE_AREA } from '@/services';
import type { AdminSession } from '@/session';

const ICONS: Record<AdminServiceId, typeof ShieldIcon> = {
  auth: KeyRoundIcon,
  users: UsersIcon,
  notifications: BellIcon,
  email: MailIcon,
};

/** The two public surfaces, opened in a new tab: they are the product, not part of the panel. */
const PRODUCT = [
  { href: '/', label: 'Открыть сайт', icon: GlobeIcon },
  { href: '/app/', label: 'Открыть приложение', icon: LayoutDashboardIcon },
];

/**
 * Sidebar of the panel: the product, the service admins, and the panel's own sections.
 *
 * Only the services the server returned are listed. That is presentation, not protection: the
 * protected URL of a hidden service passes the very same Gateway check.
 */
export function AppSidebar({ session, onLogout }: { session: AdminSession; onLogout: () => void }) {
  const allowed = new Set(session.services);
  // Which section is open, so the sidebar keeps saying where you are. Asked of the router rather
  // than compared against the address by hand: the panel is mounted under a base path, and the
  // service pages carry the service-relative route in the hash.
  const matchRoute = useMatchRoute();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        {/*
          The collapse control lives here rather than in a bar above the page. Every screen brings
          its own heading, so that bar was empty on all of them.
        */}
        <div className="flex items-center gap-2 px-2 py-1.5 group-data-[collapsible=icon]:px-0">
          <span className="truncate font-semibold group-data-[collapsible=icon]:hidden">Admin</span>
          <SidebarTrigger className="ml-auto group-data-[collapsible=icon]:ml-0" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {PRODUCT.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild tooltip={item.label}>
                    {/*
                      An ordinary link, not a frame: the site and the application are the product,
                      and an administrator opening them wants the real thing in its own tab.
                    */}
                    <a href={item.href} target="_blank" rel="noreferrer">
                      <item.icon />
                      <span className="flex-1">{item.label}</span>
                      {/*
                        The same 28px box as the collapse control in the header and the buttons in
                        the footer, so every icon on the right edge of the sidebar sits on one line.
                      */}
                      <span className="flex size-7 shrink-0 items-center justify-center group-data-[collapsible=icon]:hidden">
                        <ExternalLinkIcon className="text-muted-foreground size-3.5" />
                      </span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Сервисы</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {ADMIN_SERVICES.filter((service) => allowed.has(service.id)).map((service) => {
                const Icon = ICONS[service.id];
                return (
                  <SidebarMenuItem key={service.id}>
                    <SidebarMenuButton
                      asChild
                      tooltip={service.label}
                      isActive={Boolean(
                        matchRoute({ to: '/service/$service', params: { service: service.id } }),
                      )}
                    >
                      {/* The hash carries the service-relative path, so a deep link survives a
                          reload and the browser's back button. */}
                      <Link to="/service/$service" params={{ service: service.id }} hash="/">
                        <Icon />
                        <span>{service.label}</span>
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
                  A section of the panel, not a service: it reads every service's data at once,
                  which is why it lives here with the owner's other tools.
                */}
                {session.database ? (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      tooltip={DATABASE_AREA.label}
                      isActive={Boolean(matchRoute({ to: '/database' }))}
                    >
                      <Link to="/database">
                        <DatabaseIcon />
                        <span>{DATABASE_AREA.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center justify-between gap-2 px-2 group-data-[collapsible=icon]:flex-col">
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <p className="truncate text-sm font-medium">{session.email}</p>
            <p className="text-muted-foreground text-xs capitalize">{session.role}</p>
          </div>
          <div className="flex items-center gap-1">
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

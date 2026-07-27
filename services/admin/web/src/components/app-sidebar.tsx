import type { AdminServiceId } from '@template/contracts';
import { Link, useSearch } from '@tanstack/react-router';
import {
  DatabaseIcon,
  KeyRoundIcon,
  LogOutIcon,
  MailIcon,
  ScrollTextIcon,
  ShieldIcon,
  UsersIcon,
  BellIcon,
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

/**
 * Sidebar of admin services, the current administrator and logout.
 *
 * Only the services the server returned are listed. That is presentation, not protection: the
 * protected URL of a hidden service passes the very same Gateway check.
 */
export function AppSidebar({
  session,
  onLogout,
}: {
  session: AdminSession;
  onLogout: () => void;
}) {
  const search = useSearch({ strict: false }) as { service?: string; database?: boolean };
  const allowed = new Set(session.services);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        {/*
          The collapse control lives here rather than in a bar above the page. Every screen brings
          its own heading, so that bar was empty on all of them.
        */}
        <div className="flex items-center gap-2 px-2 py-1.5 group-data-[collapsible=icon]:px-0">
          <ShieldIcon className="size-4 shrink-0 group-data-[collapsible=icon]:hidden" />
          <span className="truncate font-semibold group-data-[collapsible=icon]:hidden">Admin</span>
          <SidebarTrigger className="ml-auto group-data-[collapsible=icon]:ml-0" />
        </div>
      </SidebarHeader>

      <SidebarContent>
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
                      isActive={search.service === service.id}
                      tooltip={service.label}
                    >
                      {/* The hash carries the service-relative path, so a deep link survives a
                          reload and the browser's back button. */}
                      <Link to="/" search={{ service: service.id, database: undefined }} hash="/">
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
            <SidebarGroupLabel>Владелец</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Администраторы">
                    <Link to="/administrators">
                      <ShieldIcon />
                      <span>Администраторы</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Журнал">
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
                      isActive={search.database === true}
                      tooltip={DATABASE_AREA.label}
                    >
                      <Link to="/" search={{ service: undefined, database: true }}>
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
            <Button variant="ghost" size="icon" onClick={onLogout} aria-label="Выйти">
              <LogOutIcon />
            </Button>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

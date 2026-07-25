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
} from '@/components/ui/sidebar';
import { ADMIN_SERVICES } from '@/services';
import type { AdminSession } from '@/session';

const ICONS: Record<AdminServiceId, typeof ShieldIcon> = {
  auth: KeyRoundIcon,
  users: UsersIcon,
  notifications: BellIcon,
  email: MailIcon,
  adminer: DatabaseIcon,
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
  const search = useSearch({ strict: false }) as { service?: string };
  const allowed = new Set(session.services);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <ShieldIcon className="size-4 shrink-0" />
          <span className="truncate font-semibold group-data-[collapsible=icon]:hidden">Admin</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Services</SidebarGroupLabel>
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
                      <Link to="/" search={{ service: service.id }} hash="/">
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
            <SidebarGroupLabel>Owner</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Administrators">
                    <Link to="/administrators">
                      <ShieldIcon />
                      <span>Administrators</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Audit">
                    <Link to="/audit">
                      <ScrollTextIcon />
                      <span>Audit</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
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
            <Button variant="ghost" size="icon" onClick={onLogout} aria-label="Log out">
              <LogOutIcon />
            </Button>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

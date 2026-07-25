import { ASSIGNABLE_SERVICE_IDS, type AssignableServiceId } from '@template/contracts';
import * as React from 'react';
import { toast } from 'sonner';

import { api } from '@/api';
import { AdminPage, ErrorState } from '@/components/layout/admin-page';
import { DataTable, Pagination } from '@/components/layout/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAsync, type Page } from '@/hooks/use-async';
import { ADMIN_SERVICES } from '@/services';
import { useSession } from '@/session';

interface Administrator {
  id: string;
  userId: string;
  email: string;
  role: 'owner' | 'admin';
  enabled: boolean;
  grants: AssignableServiceId[];
  createdAt: string;
}

const LIMIT = 25;

const SERVICE_LABELS = new Map(ADMIN_SERVICES.map((service) => [service.id, service.label]));

/**
 * Owner-only registry of administrators.
 *
 * Being an administrator is a separate fact from being a product user: this list holds only people
 * who were explicitly added here, and never everyone registered in Auth.
 */
export function AdministratorsPage() {
  const session = useSession();
  const [offset, setOffset] = React.useState(0);

  const list = useAsync<Page<Administrator>>(
    () => api.listAdministrators({ limit: LIMIT, offset }),
    [offset],
  );

  const onChanged = React.useCallback(() => list.reload(), [list]);

  if (list.error) {
    return (
      <AdminPage title="Administrators">
        <ErrorState error={list.error} retry={list.reload} />
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title="Administrators"
      description="Who may open the admin panel, and which services each of them can reach."
      actions={<AddAdministrator onAdded={onChanged} />}
    >
      <DataTable
        loading={list.loading}
        rows={list.data?.items ?? []}
        rowKey={(row) => row.id}
        empty="No administrators yet."
        columns={[
          {
            key: 'email',
            header: 'Administrator',
            cell: (row) => (
              <div className="flex flex-col">
                <span className="font-medium">{row.email}</span>
                {row.userId === session.userId ? (
                  <span className="text-muted-foreground text-xs">This is you</span>
                ) : null}
              </div>
            ),
          },
          {
            key: 'role',
            header: 'Role',
            cell: (row) => (
              <Badge variant={row.role === 'owner' ? 'default' : 'secondary'}>{row.role}</Badge>
            ),
          },
          {
            key: 'grants',
            header: 'Services',
            cell: (row) =>
              row.role === 'owner' ? (
                <span className="text-muted-foreground text-sm">Everything, including the database</span>
              ) : row.grants.length === 0 ? (
                <span className="text-muted-foreground text-sm">None</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {row.grants.map((grant) => (
                    <Badge key={grant} variant="outline">
                      {SERVICE_LABELS.get(grant) ?? grant}
                    </Badge>
                  ))}
                </div>
              ),
          },
          {
            key: 'enabled',
            header: 'Active',
            cell: (row) => (
              <EnabledSwitch administrator={row} onChanged={onChanged} />
            ),
          },
          {
            key: 'actions',
            header: '',
            className: 'text-right',
            cell: (row) => <EditAdministrator administrator={row} onChanged={onChanged} />,
          },
        ]}
      />

      <Pagination
        total={list.data?.total ?? 0}
        limit={LIMIT}
        offset={offset}
        onOffsetChange={setOffset}
      />
    </AdminPage>
  );
}

function EnabledSwitch({
  administrator,
  onChanged,
}: {
  administrator: Administrator;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState(false);

  return (
    <Switch
      checked={administrator.enabled}
      disabled={busy}
      aria-label={administrator.enabled ? 'Disable' : 'Enable'}
      onCheckedChange={(enabled) => {
        setBusy(true);
        api
          .updateAdministrator({ userId: administrator.userId, enabled })
          .then(() => {
            toast.success(enabled ? 'Administrator enabled' : 'Administrator disabled');
            onChanged();
          })
          // The server refuses to disable the last active owner; showing why is the whole point.
          .catch((error: unknown) => toast.error(messageOf(error)))
          .finally(() => setBusy(false));
      }}
    />
  );
}

function AddAdministrator({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<'owner' | 'admin'>('admin');
  const [grants, setGrants] = React.useState<AssignableServiceId[]>([]);
  const [busy, setBusy] = React.useState(false);

  const submit = () => {
    setBusy(true);
    api
      .addAdministrator({ email, role, grants })
      .then(() => {
        toast.success(`${email} can now open the admin panel`);
        setOpen(false);
        setEmail('');
        setGrants([]);
        onAdded();
      })
      .catch((error: unknown) => toast.error(messageOf(error)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add administrator</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add administrator</DialogTitle>
          <DialogDescription>
            The person must already have an account. Adding them here grants admin access; it does
            not create a user.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="administrator-email">Email</Label>
            <Input
              id="administrator-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="person@example.com"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="administrator-role">Role</Label>
            <Select value={role} onValueChange={(value) => setRole(value as 'owner' | 'admin')}>
              <SelectTrigger id="administrator-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin — only the services you grant</SelectItem>
                <SelectItem value="owner">Owner — everything, including the database</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {role === 'admin' ? <GrantPicker grants={grants} onChange={setGrants} /> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || email.trim() === ''}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditAdministrator({
  administrator,
  onChanged,
}: {
  administrator: Administrator;
  onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [role, setRole] = React.useState(administrator.role);
  const [grants, setGrants] = React.useState<AssignableServiceId[]>(administrator.grants);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setRole(administrator.role);
      setGrants(administrator.grants);
    }
  }, [administrator.grants, administrator.role, open]);

  const submit = () => {
    setBusy(true);
    api
      .updateAdministrator({ userId: administrator.userId, role, grants })
      .then(() => {
        toast.success('Access updated');
        setOpen(false);
        onChanged();
      })
      .catch((error: unknown) => toast.error(messageOf(error)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{administrator.email}</DialogTitle>
          <DialogDescription>
            A change takes effect on this administrator's next request — they do not have to log in
            again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`role-${administrator.id}`}>Role</Label>
            <Select value={role} onValueChange={(value) => setRole(value as 'owner' | 'admin')}>
              <SelectTrigger id={`role-${administrator.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="owner">Owner</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {role === 'admin' ? <GrantPicker grants={grants} onChange={setGrants} /> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which services an admin may open.
 *
 * The database is absent on purpose: Adminer is owner-only and cannot be granted to anyone, which
 * is why `ASSIGNABLE_SERVICE_IDS` is a shorter list than the sidebar.
 */
function GrantPicker({
  grants,
  onChange,
}: {
  grants: AssignableServiceId[];
  onChange: (grants: AssignableServiceId[]) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Services</legend>
      {ASSIGNABLE_SERVICE_IDS.map((id) => (
        <label key={id} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={grants.includes(id)}
            onCheckedChange={(checked) =>
              onChange(checked ? [...grants, id] : grants.filter((grant) => grant !== id))
            }
          />
          {SERVICE_LABELS.get(id) ?? id}
        </label>
      ))}
      <p className="text-muted-foreground text-xs">
        The database is owner-only and cannot be granted.
      </p>
    </fieldset>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

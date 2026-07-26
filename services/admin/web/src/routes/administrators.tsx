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

interface Candidate {
  userId: string;
  email: string;
  isAdministrator: boolean;
}

/**
 * Adding an administrator starts from an account that already exists.
 *
 * Being an administrator is permission granted to a person who has already signed up; this dialog
 * never creates an account. So instead of asking an owner to type an address exactly right and
 * refusing them afterwards, it searches Auth as they type and lets them pick.
 */
function AddAdministrator({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<'owner' | 'admin'>('admin');
  const [grants, setGrants] = React.useState<AssignableServiceId[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const candidates = useAsync<{ users: Candidate[] }>(
    () => (search === '' ? Promise.resolve({ users: [] }) : api.searchUsers({ query: search })),
    [search],
  );

  const submit = () => {
    setBusy(true);
    api
      .addAdministrator({ email, role, grants })
      .then(() => {
        toast.success(`${email} can now open the admin panel`);
        setOpen(false);
        setEmail('');
        setQuery('');
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
            <Label htmlFor="administrator-search">Who</Label>
            <Input
              id="administrator-search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setEmail('');
              }}
              placeholder="Start typing an email"
              autoComplete="off"
            />

            {email !== '' ? (
              <p className="text-sm">
                Adding <span className="font-medium">{email}</span>.{' '}
                <button
                  type="button"
                  className="underline underline-offset-4"
                  onClick={() => setEmail('')}
                >
                  Choose someone else
                </button>
              </p>
            ) : search === '' ? (
              <p className="text-muted-foreground text-xs">
                Only people who already have an account can be added — this does not create one.
              </p>
            ) : candidates.loading ? (
              <p className="text-muted-foreground text-xs">Looking…</p>
            ) : (candidates.data?.users.length ?? 0) === 0 ? (
              <p className="text-muted-foreground text-xs">
                Nobody with that address has signed up yet.
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {candidates.data?.users.map((candidate) => (
                  <li key={candidate.userId}>
                    <button
                      type="button"
                      disabled={candidate.isAdministrator}
                      onClick={() => setEmail(candidate.email)}
                      className="hover:bg-accent flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm disabled:opacity-60"
                    >
                      <span className="truncate">{candidate.email}</span>
                      {candidate.isAdministrator ? (
                        <Badge variant="secondary">Already an administrator</Badge>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
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

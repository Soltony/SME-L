'use client';

import { Fragment, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { TableCard } from '@/components/admin/data-shell';
import { useToast } from '@/hooks/use-toast';
import {
  PERMISSION_ACTIONS,
  type ModulePermission,
  type PermissionAction,
  type Permissions,
} from '@/lib/types';

interface ModuleRow {
  key: string;
  label: string;
  group: string;
  /** Permissioned tabs on that page, keyed `parent.tab`. */
  subModules: { key: string; label: string }[];
}

interface RoleRow {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  userCount: number;
  permissions: Permissions;
}

const SUPER_ADMIN = 'Super Admin';

const NO_ACTIONS = {
  read: false,
  create: false,
  update: false,
  delete: false,
  approve: false,
} as const;

const allActions = (value: boolean) => ({
  read: value,
  create: value,
  update: value,
  delete: value,
  approve: value,
});

function emptyMatrix(modules: ModuleRow[]): Permissions {
  const out: Permissions = {};
  for (const module of modules) {
    out[module.key] = { ...NO_ACTIONS };
    for (const sub of module.subModules) out[sub.key] = { ...NO_ACTIONS };
  }
  return out;
}

/**
 * Re-derives a module row from its tabs, so the saved matrix never claims
 * something its tabs do not back. `read` opens the page, so one readable tab is
 * enough; every other action is only true once every tab carries it.
 */
function syncModuleRow(draft: Permissions, module: ModuleRow) {
  if (module.subModules.length === 0) return;
  const rolled: ModulePermission = {};
  for (const action of PERMISSION_ACTIONS) {
    const values = module.subModules.map((sub) => Boolean(draft[sub.key]?.[action]));
    rolled[action] = action === 'read' ? values.some(Boolean) : values.every(Boolean);
  }
  draft[module.key] = rolled;
}

export function RoleBuilder({
  roles,
  modules,
  canCreate,
  canUpdate,
  canDelete,
}: {
  roles: RoleRow[];
  modules: ModuleRow[];
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState(roles[0]?.id ?? '');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const selected = roles.find((role) => role.id === selectedId) ?? roles[0];
  const isSuperAdmin = selected?.name === SUPER_ADMIN;
  const locked = !canUpdate || isSuperAdmin;

  const [draft, setDraft] = useState<Permissions>(
    selected ? { ...emptyMatrix(modules), ...selected.permissions } : emptyMatrix(modules)
  );
  const [draftRoleId, setDraftRoleId] = useState(selected?.id ?? '');
  /** Modules whose tabs are showing. Collapsed until asked for. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Switching roles re-seeds the draft from the newly selected role.
  if (selected && selected.id !== draftRoleId) {
    setDraftRoleId(selected.id);
    setDraft({ ...emptyMatrix(modules), ...selected.permissions });
  }

  // Which module a tab belongs to, so editing a tab can re-roll its module row.
  const moduleOfTab = new Map<string, ModuleRow>();
  for (const module of modules) {
    for (const sub of module.subModules) moduleOfTab.set(sub.key, module);
  }

  /** One action on one row: a module without tabs, or a single tab. */
  const toggle = (key: string, action: PermissionAction, value: boolean) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: { ...prev[key], [action]: value } };
      // Any action implies being able to open what it applies to.
      if (value && action !== 'read') next[key].read = true;
      // Losing read means losing everything on that row.
      if (!value && action === 'read') next[key] = { ...NO_ACTIONS };

      const module = moduleOfTab.get(key);
      if (module) syncModuleRow(next, module);
      return next;
    });
  };

  /** Every action on one row. */
  const toggleRowAll = (key: string, value: boolean) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: allActions(value) };
      const module = moduleOfTab.get(key);
      if (module) syncModuleRow(next, module);
      return next;
    });
  };

  /**
   * A module row that has tabs is a bulk control: the click lands on every tab
   * under it, and the module row is re-derived from the result.
   */
  const toggleModule = (module: ModuleRow, action: PermissionAction, value: boolean) => {
    setDraft((prev) => {
      const next = { ...prev };
      for (const sub of module.subModules) {
        next[sub.key] = { ...next[sub.key], [action]: value };
        if (value && action !== 'read') next[sub.key].read = true;
        if (!value && action === 'read') next[sub.key] = { ...NO_ACTIONS };
      }
      syncModuleRow(next, module);
      return next;
    });
  };

  const toggleModuleAll = (module: ModuleRow, value: boolean) => {
    if (module.subModules.length === 0) {
      toggleRowAll(module.key, value);
      return;
    }
    setDraft((prev) => {
      const next = { ...prev };
      for (const sub of module.subModules) next[sub.key] = allActions(value);
      syncModuleRow(next, module);
      return next;
    });
  };

  /**
   * How a module's own box reads when its tabs hold the grants: ticked when
   * every tab has the action, a dash when only some do.
   */
  const rollUp = (module: ModuleRow, action: PermissionAction): boolean | 'indeterminate' => {
    const granted = module.subModules.filter((sub) => draft[sub.key]?.[action]).length;
    if (granted === 0) return false;
    return granted === module.subModules.length ? true : 'indeterminate';
  };

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/roles/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: draft }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        toast({ variant: 'destructive', title: 'Save failed', description: data?.error });
        return;
      }

      toast({ title: `${selected.name} permissions saved` });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const createRole = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch('/api/admin/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, permissions: emptyMatrix(modules) }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        toast({ variant: 'destructive', title: 'Could not create role', description: data?.error });
        return;
      }

      toast({ title: 'Role created', description: 'Now grant it the modules it needs.' });
      setCreating(false);
      setNewName('');
      setSelectedId(data.id);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const removeRole = async (role: RoleRow) => {
    const response = await fetch(`/api/admin/roles/${role.id}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      toast({ variant: 'destructive', title: 'Cannot delete', description: data?.error });
      return;
    }
    toast({ title: 'Role deleted' });
    setSelectedId(roles.find((r) => r.id !== role.id)?.id ?? '');
    router.refresh();
  };

  const groups = Array.from(new Set(modules.map((module) => module.group)));

  return (
    <div className="grid gap-4 lg:grid-cols-4">
      <div className="space-y-3 lg:col-span-1">
        {canCreate && (
          <>
            {creating ? (
              <form
                onSubmit={createRole}
                className="space-y-2 rounded-xl border border-border bg-card p-3"
              >
                <Label htmlFor="role-name">New role name</Label>
                <Input
                  id="role-name"
                  required
                  autoFocus
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Collections Officer"
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={busy || !newName.trim()}>
                    {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    Create
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setCreating(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <Button className="w-full" onClick={() => setCreating(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                New role
              </Button>
            )}
          </>
        )}

        <ul className="space-y-1.5">
          {roles.map((role) => (
            <li key={role.id}>
              <button
                type="button"
                onClick={() => setSelectedId(role.id)}
                className={cn(
                  'w-full rounded-xl border p-3 text-left transition',
                  role.id === selected?.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-card hover:bg-secondary/40'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{role.name}</span>
                  {role.name === SUPER_ADMIN && (
                    <Badge variant="default" className="px-1.5 py-0 text-[10px]">
                      Full
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {role.userCount} user{role.userCount === 1 ? '' : 's'}
                </p>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="lg:col-span-3">
        {!selected ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            Create a role to get started.
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-lg font-bold">
                  <ShieldCheck className="h-5 w-5 text-primary" />
                  {selected.name}
                </h2>
                {isSuperAdmin && (
                  <p className="text-xs text-muted-foreground">
                    Super Admin bypasses every permission check — this matrix is read-only.
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                {canDelete && !selected.isSystem && !isSuperAdmin && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => removeRole(selected)}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Delete role
                  </Button>
                )}
                {!locked && (
                  <Button size="sm" onClick={save} disabled={busy}>
                    {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    Save permissions
                  </Button>
                )}
              </div>
            </div>

            <TableCard>
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b border-border bg-secondary/50 text-left">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Module</th>
                    {PERMISSION_ACTIONS.map((action) => (
                      <th key={action} className="px-3 py-2.5 text-center font-semibold capitalize">
                        {action}
                      </th>
                    ))}
                    <th className="px-3 py-2.5 text-center font-semibold">All</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {groups.map((group) => (
                    <Fragment key={group}>
                      <tr className="bg-secondary/30">
                        <td
                          colSpan={PERMISSION_ACTIONS.length + 2}
                          className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                        >
                          {group}
                        </td>
                      </tr>
                      {modules
                        .filter((module) => module.group === group)
                        .map((module) => {
                          const perms = draft[module.key] ?? {};
                          // A module with tabs is a bulk control over them: its
                          // boxes read as ticked, dashed or empty accordingly.
                          const hasTabs = module.subModules.length > 0;
                          const isOpen = expanded.has(module.key);
                          const openTabs = isSuperAdmin
                            ? module.subModules.length
                            : module.subModules.filter((sub) => draft[sub.key]?.read).length;
                          const allOn = isSuperAdmin
                            ? true
                            : hasTabs
                              ? PERMISSION_ACTIONS.every((a) => rollUp(module, a) === true)
                              : PERMISSION_ACTIONS.every((a) => perms[a]);

                          return (
                            <Fragment key={module.key}>
                              <tr className="hover:bg-secondary/20">
                                <td className="px-4 py-2 font-medium">
                                  {hasTabs ? (
                                    <button
                                      type="button"
                                      onClick={() => toggleExpanded(module.key)}
                                      aria-expanded={isOpen}
                                      className="-ml-1 flex items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-secondary/60"
                                    >
                                      <ChevronRight
                                        className={cn(
                                          'h-3.5 w-3.5 text-muted-foreground transition-transform',
                                          isOpen && 'rotate-90'
                                        )}
                                      />
                                      {module.label}
                                      <Badge
                                        variant="secondary"
                                        className="px-1.5 py-0 text-[10px] font-normal"
                                      >
                                        {openTabs}/{module.subModules.length} tabs
                                      </Badge>
                                    </button>
                                  ) : (
                                    module.label
                                  )}
                                </td>
                                {PERMISSION_ACTIONS.map((action) => (
                                  <td key={action} className="px-3 py-2 text-center">
                                    <Checkbox
                                      checked={
                                        isSuperAdmin ||
                                        (hasTabs ? rollUp(module, action) : Boolean(perms[action]))
                                      }
                                      disabled={locked}
                                      onCheckedChange={(checked) =>
                                        hasTabs
                                          ? toggleModule(module, action, Boolean(checked))
                                          : toggle(module.key, action, Boolean(checked))
                                      }
                                      aria-label={`${action} ${module.label}${
                                        hasTabs ? ' and every tab on it' : ''
                                      }`}
                                    />
                                  </td>
                                ))}
                                <td className="px-3 py-2 text-center">
                                  <Checkbox
                                    checked={allOn}
                                    disabled={locked}
                                    onCheckedChange={(checked) =>
                                      toggleModuleAll(module, Boolean(checked))
                                    }
                                    aria-label={`Grant all on ${module.label}`}
                                  />
                                </td>
                              </tr>

                              {isOpen &&
                                module.subModules.map((sub) => {
                                  const subPerms = draft[sub.key] ?? {};
                                  const subAllOn =
                                    isSuperAdmin || PERMISSION_ACTIONS.every((a) => subPerms[a]);

                                  return (
                                    <tr key={sub.key} className="bg-secondary/10 hover:bg-secondary/30">
                                      <td className="py-2 pl-10 pr-4 text-muted-foreground">
                                        <span className="mr-1.5 text-border">└</span>
                                        {sub.label}
                                      </td>
                                      {PERMISSION_ACTIONS.map((action) => (
                                        <td key={action} className="px-3 py-2 text-center">
                                          <Checkbox
                                            checked={isSuperAdmin || Boolean(subPerms[action])}
                                            disabled={locked}
                                            onCheckedChange={(checked) =>
                                              toggle(sub.key, action, Boolean(checked))
                                            }
                                            aria-label={`${action} ${module.label} ${sub.label}`}
                                          />
                                        </td>
                                      ))}
                                      <td className="px-3 py-2 text-center">
                                        <Checkbox
                                          checked={subAllOn}
                                          disabled={locked}
                                          onCheckedChange={(checked) =>
                                            toggleRowAll(sub.key, Boolean(checked))
                                          }
                                          aria-label={`Grant all on ${module.label} ${sub.label}`}
                                        />
                                      </td>
                                    </tr>
                                  );
                                })}
                            </Fragment>
                          );
                        })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </TableCard>

            <p className="mt-3 text-xs text-muted-foreground">
              <strong>Read</strong> opens the module. <strong>Approve</strong> is the second-pair-of-eyes
              right: approving loans, write-offs, reversals, capital movements and configuration changes requested by others.
              Rows with a <strong>tabs</strong> count expand: ticking the module applies to every tab
              under it, and a dashed box means only some of them have it. A tab with nothing ticked
              is hidden from that page entirely.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

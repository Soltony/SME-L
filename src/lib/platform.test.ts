import { afterEach, describe, expect, it } from 'vitest';
import { dateFromDay, dayFromDate, dayToIso, isoToDay, today } from './business-date';
import {
  ADMIN_ROUTES,
  API_ROLE_CONSTRAINTS,
  findAdminRoute,
  moduleKeyFor,
  moduleKeyForApiPath,
} from './route-permissions';
import { hasPermission, sanitizePermissions } from './permissions';
import { checkRequestOrigin } from './request-context';
import { isCbsSimulated, isTestLoginEnabled } from './dev-switches';
import { ROLE_PRESETS } from './role-presets';
import { CHANGE_HANDLERS } from './approvals';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('business calendar', () => {
  it('counts days in the business timezone, not the server clock', () => {
    process.env.BUSINESS_UTC_OFFSET_MINUTES = '180';
    // 22:30 UTC on 1 March is 01:30 on 2 March in Addis Ababa.
    expect(dayToIso(today(new Date('2026-03-01T22:30:00Z')))).toBe('2026-03-02');
    expect(dayToIso(today(new Date('2026-03-01T20:59:00Z')))).toBe('2026-03-01');
  });

  it('round-trips date columns exactly', () => {
    const day = isoToDay('2026-09-16');
    expect(dayFromDate(dateFromDay(day))).toBe(day);
    expect(() => isoToDay('2026-02-30')).toThrow();
  });

  it('refuses a pinned business date in production', () => {
    process.env.BUSINESS_DATE_OVERRIDE = '2026-01-01';
    (process.env as Record<string, string>).NODE_ENV = 'test';
    expect(dayToIso(today())).toBe('2026-01-01');
    (process.env as Record<string, string>).NODE_ENV = 'production';
    expect(() => today()).toThrow(/production/);
  });
});

describe('development switches', () => {
  it('are hard-off in production whatever the variables say', () => {
    process.env.ALLOW_TEST_LOGIN = 'true';
    process.env.CBS_SIMULATE = 'true';
    (process.env as Record<string, string>).NODE_ENV = 'development';
    expect(isTestLoginEnabled()).toBe(true);
    expect(isCbsSimulated()).toBe(true);
    (process.env as Record<string, string>).NODE_ENV = 'production';
    expect(isTestLoginEnabled()).toBe(false);
    expect(isCbsSimulated()).toBe(false);
  });
});

describe('route registry', () => {
  it('matches whole path segments only', () => {
    expect(findAdminRoute('/admin/loans/abc')?.label).toBe('Loans');
    expect(findAdminRoute('/admin')?.label).toBe('Dashboard');
  });

  it('maps every admin API to a module, and leaves unknown ones unmapped (denied)', () => {
    expect(moduleKeyForApiPath('/api/admin/loans/abc')).toBe('loans');
    expect(moduleKeyForApiPath('/api/admin/roles')).toBe('access-control');
    expect(moduleKeyForApiPath('/api/admin/something-new')).toBeUndefined();
  });

  it('applies page role constraints to the APIs behind them', () => {
    expect(API_ROLE_CONSTRAINTS['users']).toEqual(['Super Admin']);
    expect(API_ROLE_CONSTRAINTS['access-control']).toEqual(['Super Admin']);
    expect(API_ROLE_CONSTRAINTS['audit-logs']).toContain('Auditor');
  });
});

describe('permissions', () => {
  it('drops unknown modules from a role and never grants by accident', () => {
    const clean = sanitizePermissions({ loans: { read: true, approve: 'yes' as unknown as boolean }, 'made-up': { read: true } });
    expect(clean['made-up']).toBeUndefined();
    expect(clean.loans).toMatchObject({ read: true, approve: true, delete: false });
    expect(hasPermission({ role: 'Finance', permissions: clean }, 'loans', 'delete')).toBe(false);
    expect(hasPermission({ role: 'Super Admin', permissions: {} }, 'loans', 'delete')).toBe(true);
  });

  it('keeps makers and checkers apart in the preset roles', () => {
    const approver = ROLE_PRESETS.find((r) => r.name === 'Approver')!;
    const finance = ROLE_PRESETS.find((r) => r.name === 'Finance')!;
    for (const [key, grant] of Object.entries(approver.permissions)) {
      expect(grant.create || grant.update || grant.delete, `Approver can change ${key}`).toBe(false);
    }
    for (const grant of Object.values(finance.permissions)) {
      expect(grant.approve).toBe(false);
    }
  });

  it('gives every maker-checker kind a module that exists', () => {
    const modules = new Set(ADMIN_ROUTES.map((r) => moduleKeyFor(r.label)));
    for (const [kind, handler] of Object.entries(CHANGE_HANDLERS)) {
      expect(modules.has(handler.module), `${kind} → ${handler.module}`).toBe(true);
    }
  });
});

describe('same-origin check', () => {
  const url = new URL('http://localhost:3006/api/admin/loans');
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it('refuses a cross-site POST', () => {
    expect(checkRequestOrigin(headers({ origin: 'https://evil.example' }), url)).toBe('cross-origin');
  });

  it('accepts the public host behind a reverse proxy via the Host header', () => {
    expect(
      checkRequestOrigin(headers({ origin: 'https://lending.example.et', host: 'lending.example.et' }), url)
    ).toBe('same-origin');
  });

  it('reports a request with no origin at all as missing, not as same-origin', () => {
    expect(checkRequestOrigin(headers({}), url)).toBe('missing');
  });
});

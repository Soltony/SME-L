import {
  BadgeDollarSign,
  BarChart3,
  BookOpenCheck,
  BookUser,
  Building2,
  CheckSquare,
  ClipboardList,
  Gauge,
  Landmark,
  LayoutDashboard,
  Package,
  Send,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { ADMIN_ROUTES, moduleKeyFor, type SubModule } from './route-permissions';

export { moduleKeyFor, MODULE_KEYS, findAdminRoute, subModuleKey, subModulesFor } from './route-permissions';

export type MenuGroup = 'Operations' | 'Lending setup' | 'Finance' | 'Governance' | 'System';

export interface MenuItem {
  path: string;
  label: string;
  moduleKey: string;
  icon: LucideIcon;
  roles?: string[];
  group: MenuGroup;
  subModules?: SubModule[];
}

const DECORATION: Record<string, { icon: LucideIcon; group: MenuGroup }> = {
  '/admin': { icon: LayoutDashboard, group: 'Operations' },
  '/admin/applications': { icon: ClipboardList, group: 'Operations' },
  '/admin/loans': { icon: BadgeDollarSign, group: 'Operations' },
  '/admin/disbursements': { icon: Send, group: 'Operations' },
  '/admin/repayments': { icon: Landmark, group: 'Operations' },
  '/admin/borrowers': { icon: Users, group: 'Operations' },
  '/admin/providers': { icon: Building2, group: 'Lending setup' },
  '/admin/products': { icon: Package, group: 'Lending setup' },
  '/admin/credit-scoring': { icon: Gauge, group: 'Lending setup' },
  '/admin/accounting': { icon: BookOpenCheck, group: 'Finance' },
  '/admin/reports': { icon: BarChart3, group: 'Finance' },
  '/admin/approvals': { icon: CheckSquare, group: 'Governance' },
  '/admin/audit-logs': { icon: BookUser, group: 'Governance' },
  '/admin/users': { icon: UserCog, group: 'System' },
  '/admin/access-control': { icon: ShieldCheck, group: 'System' },
  '/admin/settings': { icon: Settings, group: 'System' },
};

export const MENU_GROUP_ORDER: MenuGroup[] = ['Operations', 'Lending setup', 'Finance', 'Governance', 'System'];

export const allMenuItems: MenuItem[] = ADMIN_ROUTES.map((route) => ({
  ...route,
  moduleKey: moduleKeyFor(route.label),
  icon: DECORATION[route.path]?.icon ?? LayoutDashboard,
  group: DECORATION[route.path]?.group ?? 'Operations',
}));

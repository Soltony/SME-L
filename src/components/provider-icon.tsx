import { Briefcase, Building2, Coins, CreditCard, HandCoins, Landmark, PiggyBank, Wallet, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DEFAULT_PROVIDER_ICON, isUploadedIcon, type ProviderIconName } from '@/lib/provider-icon';

/** Keyed by the names in PROVIDER_ICON_NAMES — the two lists move together. */
export const PROVIDER_ICONS: Record<ProviderIconName, LucideIcon> = {
  Landmark,
  Building2,
  Briefcase,
  Wallet,
  CreditCard,
  PiggyBank,
  Coins,
  HandCoins,
};

/**
 * A provider's mark: the icon it chose, tinted with its brand colour.
 *
 * Decorative throughout — the provider's name is always beside it — so it is
 * hidden from assistive technology rather than read out twice.
 *
 * An uploaded icon goes through `<img>` and nothing else. An SVG loaded that
 * way cannot run script, which is what makes accepting SVG uploads safe; it
 * also keeps its own colours, so only the named icons take the brand tint.
 */
export function ProviderIcon({
  icon,
  color,
  className,
}: {
  icon: string;
  color?: string;
  className?: string;
}) {
  if (isUploadedIcon(icon)) {
    return <img src={icon} alt="" aria-hidden className={cn('h-5 w-5 shrink-0 object-contain', className)} />;
  }
  const name = (icon in PROVIDER_ICONS ? icon : DEFAULT_PROVIDER_ICON) as ProviderIconName;
  const Icon = PROVIDER_ICONS[name];
  return <Icon aria-hidden className={cn('h-5 w-5 shrink-0', className)} style={color ? { color } : undefined} />;
}

/** The icon inside a soft brand-coloured tile, for list rows and page headers. */
export function ProviderBadge({
  icon,
  color,
  className,
  iconClassName,
}: {
  icon: string;
  color: string;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      className={cn('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border', className)}
      style={{ backgroundColor: `${color}1a`, borderColor: `${color}40` }}
    >
      <ProviderIcon icon={icon} color={color} className={iconClassName} />
    </span>
  );
}

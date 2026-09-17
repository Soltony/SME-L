import { cn } from '@/lib/utils';

/**
 * The platform's mark: the operator's uploaded logo when `platform.logo` is
 * set, otherwise the built-in one below — rising bars on a ledger line, lending
 * that grows a business. Inline so it follows currentColor.
 *
 * An uploaded logo goes through `<img>` and nothing else, which is what makes
 * accepting an SVG safe: markup loaded that way cannot run script.
 */
export function LogoMark({ className, src }: { className?: string; src?: string | null }) {
  if (src) {
    return <img src={src} alt="" aria-hidden className={cn('h-7 w-7 shrink-0 object-contain', className)} />;
  }
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={cn('h-7 w-7', className)} aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <rect x="7" y="17" width="4" height="7" rx="1.2" fill="#0B1220" opacity="0.45" />
      <rect x="14" y="13" width="4" height="11" rx="1.2" fill="#0B1220" opacity="0.7" />
      <rect x="21" y="8" width="4" height="16" rx="1.2" fill="#0B1220" />
      <rect x="6" y="25.5" width="20" height="1.5" rx="0.75" fill="#0B1220" opacity="0.8" />
    </svg>
  );
}

export function LogoWordmark({
  className,
  name = 'SME Lending',
  logo,
}: {
  className?: string;
  name?: string;
  logo?: string | null;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-extrabold tracking-tight', className)}>
      <LogoMark src={logo} className="h-7 w-7 shrink-0" />
      <span className="text-foreground">{name}</span>
    </span>
  );
}

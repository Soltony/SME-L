import { Button } from '@/components/ui/button';

/** Small server-rendered GET filter controls, so filtered pages are linkable. */

export function SelectFilter({
  name,
  label,
  value,
  options,
  allLabel = 'All',
}: {
  name: string;
  label: string;
  value?: string;
  options: { value: string; label: string }[];
  allLabel?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <select
        name={name}
        defaultValue={value ?? ''}
        className="h-9 min-w-[150px] rounded-md border border-input bg-background px-2 text-sm text-foreground"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TextFilter({ name, label, value, placeholder, type = 'text' }: { name: string; label: string; value?: string; placeholder?: string; type?: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <input
        name={name}
        type={type}
        defaultValue={value ?? ''}
        placeholder={placeholder}
        className="h-9 min-w-[150px] rounded-md border border-input bg-background px-2 text-sm text-foreground"
      />
    </label>
  );
}

export function FilterSubmit() {
  return (
    <Button type="submit" size="sm" variant="secondary" className="h-9">
      Apply
    </Button>
  );
}

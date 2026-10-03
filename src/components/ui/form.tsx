import { Check, ChevronDown } from "lucide-react";
import { Checkbox as RCheckbox, Slider as RSlider, Switch as RSwitch } from "radix-ui";
import type {
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

import { cn } from "../../lib/cn";

const field =
  "w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg placeholder:text-subtle transition-colors focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-50";

export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cn(field, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(field, "min-h-20 py-2", className)} {...props} />;
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <div className={cn("relative", className)}>
      <select className={cn(field, "h-9 appearance-none pr-8")} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted" />
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-subtle">{hint}</span>}
    </label>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="relative h-5 w-9 shrink-0 rounded-full border border-line-strong bg-surface-3 transition-colors focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
    >
      <RSwitch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-fg shadow transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-accent-ink" />
    </RSwitch.Root>
  );
}

export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  label,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <RCheckbox.Root
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded border border-line-strong bg-surface-2 transition-colors focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none disabled:opacity-40 data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        className,
      )}
    >
      <RCheckbox.Indicator>
        <Check className="size-3 text-accent-ink" strokeWidth={3} />
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onValueChange,
  disabled,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onValueChange: (value: number) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <RSlider.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={([v]) => onValueChange(v)}
      aria-label={label}
      className="relative flex h-5 w-full touch-none items-center select-none data-[disabled]:opacity-40"
    >
      <RSlider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-surface-3">
        <RSlider.Range className="absolute h-full bg-accent" />
      </RSlider.Track>
      <RSlider.Thumb className="block size-4 rounded-full border-2 border-accent bg-fg shadow focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none" />
    </RSlider.Root>
  );
}

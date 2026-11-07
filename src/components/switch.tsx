/** An on/off switch. It is a real checkbox, so it must sit inside a label and submits with the form. */
export function Switch({ id, name, value, defaultChecked, disabled }: { id?: string; name: string; value?: string; defaultChecked?: boolean; disabled?: boolean }) {
  return (
    <>
      <input id={id} type="checkbox" name={name} value={value} defaultChecked={defaultChecked} disabled={disabled} className="peer sr-only" />
      <span aria-hidden className="relative h-5 w-9 shrink-0 rounded-full bg-slate-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-brand peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-disabled:opacity-50" />
    </>
  );
}

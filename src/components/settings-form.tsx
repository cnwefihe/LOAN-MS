import { SETTINGS, type SettingGroup, type SettingKey } from "@/server/settings";
import { saveSettingsGroupAction } from "@/app/actions/admin";
import { ActionForm } from "@/components/action-form";
import { Switch } from "@/components/switch";
import { DURATION_UNITS, splitMinutes } from "@/lib/duration";

const MULTILINE = new Set<SettingKey>(["system.announcement", "notifications.emailSignature"]);
const FULL_WIDTH = new Set<SettingKey>([...MULTILINE, "documents.footerNotice"]);

const optionLabel = (o: string, numeric: boolean) => {
  return numeric ? `${o} minutes` : o.charAt(0).toUpperCase() + o.slice(1);
};

const typeOf = (k: SettingKey) => SETTINGS[k].schema._zod.def.type;

/** One form per settings group: switches first, then the fields, in two aligned columns. */
export function SettingsGroupForm({ group, values }: { group: SettingGroup; values: Partial<Record<SettingKey, unknown>> }) {
  const keys = (Object.keys(SETTINGS) as SettingKey[]).filter((k) => SETTINGS[k].group === group);
  const switches = keys.filter((k) => typeOf(k) === "boolean");
  const fields = keys.filter((k) => typeOf(k) !== "boolean");
  const sensitive = keys.some((k) => SETTINGS[k].sensitive);
  return (
    <ActionForm action={saveSettingsGroupAction.bind(null, group)} submitLabel="Save changes"
      listChanges confirm={sensitive ? "Save these changes? They apply at once and are flagged in the audit log." : "Save these changes? They apply at once."}>
      {keys.map((k) => <input key={k} type="hidden" name="__keys" value={k} />)}
      {sensitive && <input type="hidden" name="confirm" value="yes" />}
      {switches.length > 0 && (
        <div className={`divide-y divide-line ${fields.length ? "mb-5 border-b border-line" : ""}`}>
          {switches.map((k) => (
            <label key={k} className="flex cursor-pointer items-center gap-3 py-2.5 text-sm first:pt-0">
              <Switch id={`s-${k.replace(/\./g, "-")}`} name={k} defaultChecked={Boolean(values[k])} />
              <span>{SETTINGS[k].label}</span>
            </label>
          ))}
        </div>
      )}
      {fields.length > 0 && (
        <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
          {fields.map((k) => {
            const def = SETTINGS[k];
            const type = typeOf(k);
            const v = values[k];
            const id = `s-${k.replace(/\./g, "-")}`;
            const options = "options" in def ? def.options : null;
            return (
              <div key={k} className={FULL_WIDTH.has(k) ? "md:col-span-2" : undefined}>
                <label htmlFor={id} className="label">{def.label}</label>
                {options ? (
                  <select id={id} name={k} defaultValue={String(v)} className="input">
                    {options.map((o) => <option key={o} value={o}>{("optionLabels" in def ? (def.optionLabels as Record<string, string>)[o] : undefined) ?? optionLabel(o, type === "number")}</option>)}
                  </select>
                ) : (k.startsWith("reminders.") || k.startsWith("automation.")) && k.endsWith("Minutes") ? (
                  <div className="flex gap-2">
                    <input id={id} name={k} type="number" min={1} required defaultValue={splitMinutes(Number(v)).amount} className="input min-w-0 flex-1" />
                    <select aria-label={`${def.label}: unit`} name={`${k}__unit`} defaultValue={splitMinutes(Number(v)).unit} className="input w-28">
                      {DURATION_UNITS.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
                    </select>
                  </div>
                ) : k === "branding.primaryColour" ? (
                  <div className="flex items-center gap-3">
                    <input id={id} name={k} type="color" defaultValue={String(v).toLowerCase()} className="h-9 w-14 cursor-pointer rounded border border-slate-300 bg-white p-1" />
                    <span className="text-xs text-muted"><span className="font-mono">{String(v)}</span>. Must contrast with white text (at least 4.5:1).</span>
                  </div>
                ) : MULTILINE.has(k) ? (
                  <textarea id={id} name={k} rows={2} defaultValue={String(v ?? "")} className="input" />
                ) : (
                  <input id={id} name={k} type={type === "number" ? "number" : k.endsWith("Email") ? "email" : "text"} defaultValue={String(v ?? "")} className="input" />
                )}
              </div>
            );
          })}
        </div>
      )}
    </ActionForm>
  );
}

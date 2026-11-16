import { Field } from "./ui";

/** Name, email and cadre of someone on the list of guarantors. */
export function GuarantorFields({ name, email, cadre }: { name?: string; email?: string; cadre?: string }) {
  return (
    <div className="grid gap-3">
      <Field label="Full name" htmlFor="name"><input id="name" name="name" required defaultValue={name} className="input" /></Field>
      <Field label="Work email" htmlFor="email" hint="Not shown to applicants."><input id="email" name="email" type="email" required defaultValue={email} className="input" /></Field>
      <Field label="Cadre" htmlFor="cadre"><input id="cadre" name="cadre" defaultValue={cadre ?? "Managerial"} className="input" /></Field>
    </div>
  );
}

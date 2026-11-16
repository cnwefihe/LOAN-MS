/** A staff member's designation: the one Human Resources saved, otherwise their job title in the staff directory. */
export function designationOf(p: { entraJobTitle?: string | null; designation?: string | null } | null | undefined): string | null {
  return p?.designation?.trim() || p?.entraJobTitle?.trim() || null;
}

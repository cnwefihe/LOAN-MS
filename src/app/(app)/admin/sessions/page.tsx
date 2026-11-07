import { redirect } from "next/navigation";

/** Sessions now live under Activity. */
export default function Sessions() {
  redirect("/admin/audit?tab=sessions");
}

import { redirect } from "next/navigation";
import { getActor } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Signed-in people go to their own starting page, such as the Control centre for administrators.
  redirect((await getActor()) ? "/home" : "/login");
}

import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { notificationTemplates } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { ActionForm } from "@/components/action-form";
import { Card, PageHeader } from "@/components/ui";
import { saveTemplateAction } from "@/app/actions/admin";

export const metadata = { title: "Notification template" };

export default async function EditTemplate({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ from?: string }> }) {
  await requireActor("admin.content.manage");
  const { code } = await params;
  const sp = await searchParams;
  const [t] = await (await getDb()).select().from(notificationTemplates).where(eq(notificationTemplates.code, code));
  if (!t) notFound();
  return (
    <>
      <PageHeader title={t.name} crumbs={[{ label: "Administration", href: "/admin" }, { label: "Templates", href: (sp.from?.startsWith("/admin/content") ? sp.from : "/admin/content?tab=templates") }, { label: t.name }]} />
      <Card className="max-w-3xl" description="Placeholders such as {{reference}} and {{amount}} are filled in automatically." title="Message">
        <ActionForm action={saveTemplateAction.bind(null, t.code)} submitLabel="Save template" listChanges confirm="Save these changes to the template? New messages will use it.">
          <label htmlFor="subject" className="label">Subject</label>
          <input id="subject" name="subject" defaultValue={t.subject} required className="input" />
          <label htmlFor="body" className="label mt-3">Body</label>
          <textarea id="body" name="body" rows={10} defaultValue={t.body} required className="input text-sm" />
          <div className="mt-4 flex gap-6 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="sendEmail" defaultChecked={t.sendEmail} className="h-4 w-4 accent-brand" />Send email</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="isActive" defaultChecked={t.isActive} className="h-4 w-4 accent-brand" />Active</label>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}

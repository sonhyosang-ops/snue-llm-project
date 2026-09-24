import { redirect } from "next/navigation";
import { AdminConsole } from "./admin-console";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function AdminPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "system_developer" && profile?.role !== "vice_principal") redirect("/");
  return <AdminConsole />;
}

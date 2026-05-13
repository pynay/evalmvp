import { createClient } from '@/lib/supabase/server';

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return (
    <main>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-neutral-600">Signed in as {user!.email}</p>
      <p className="mt-4 text-sm text-neutral-500">Workspace data will appear here once Task 7 lands.</p>
    </main>
  );
}

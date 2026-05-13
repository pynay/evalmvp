import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { Route } from 'next';
import type { ReactNode } from 'react';

export default async function AuthedLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth/sign-in' as Route);
  return <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>;
}

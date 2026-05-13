'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function SignIn() {
  return (
    <Suspense fallback={null}>
      <SignInInner />
    </Suspense>
  );
}

function SignInInner() {
  const params = useSearchParams();
  const initialError = params.get('error') === 'auth_failed'
    ? 'Sign-in link expired or invalid. Try again.'
    : null;
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(initialError);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setErrorMsg(error.message);
      return;
    }
    setSent(true);
  }

  if (sent) return <main className="p-8">Check your email for the magic link (or Inbucket at http://127.0.0.1:54324 for local dev).</main>;

  return (
    <main className="mx-auto max-w-md px-6 py-24">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="w-full rounded border px-3 py-2"
        />
        <button type="submit" className="w-full rounded bg-black px-4 py-2 text-white">
          Send magic link
        </button>
        {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}
      </form>
    </main>
  );
}

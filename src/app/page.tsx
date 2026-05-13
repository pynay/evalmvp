import Link from 'next/link';
import type { Route } from 'next';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-3xl font-semibold">EvalMVP</h1>
      <p className="mt-4 text-neutral-600">Eval-gated cold email generation.</p>
      <Link href={'/auth/sign-in' as Route} className="mt-8 inline-block rounded bg-black px-4 py-2 text-white">
        Sign in
      </Link>
    </main>
  );
}

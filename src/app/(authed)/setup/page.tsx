import { getSetup } from './actions';
import { SetupForm } from './SetupForm';

export default async function SetupPage() {
  const initial = await getSetup();

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-3xl font-semibold">Setup</h1>
      <p className="mt-2 text-neutral-600">
        Configure your ICP, sender identity, and voice samples. Used by the eval-gated generation loop.
      </p>
      <div className="mt-8">
        <SetupForm initial={initial} />
      </div>
    </main>
  );
}

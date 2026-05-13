import { inngest } from '../client';

export const hello = inngest.createFunction(
  { id: 'hello' },
  { event: 'test/hello' },
  async ({ event, step }) => {
    await step.run('greet', () => ({ greeted: (event.data as { name?: string } | undefined)?.name ?? 'world' }));
    return { ok: true };
  },
);

import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { hello } from '@/lib/inngest/functions/hello';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [hello],
  signingKey: process.env.INNGEST_SIGNING_KEY,
});

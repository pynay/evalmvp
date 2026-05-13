import { Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'evalmvp',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

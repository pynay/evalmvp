/**
 * Apify LinkedIn profile scraper wrapper.
 *
 * Uses the `dev_fusion/linkedin-profile-scraper` actor per spec §9. Apify's
 * run-sync-get-dataset-items endpoint blocks until the actor finishes and
 * returns the dataset items directly — good for one-prospect-at-a-time
 * enrichment in the prospect-upload server action.
 *
 * Cost ~$0.005 per profile. Timeout ~30s per call.
 */

const APIFY_ACTOR_ID = 'dev_fusion~linkedin-profile-scraper';
const APIFY_TIMEOUT_MS = 30_000;

export interface LinkedinProfile {
  // Free-form — different actors return slightly different shapes. We pass the
  // raw object through to the prospects.enrichment_jsonb column. The
  // Personalization judge does the work of identifying useful fields.
  [key: string]: unknown;
}

export async function scrapeLinkedinProfile(url: string): Promise<LinkedinProfile | null> {
  const apiKey = process.env.APIFY_API_KEY;
  if (!apiKey) throw new Error('APIFY_API_KEY not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APIFY_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items?token=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileUrls: [url] }),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Apify ${res.status}: ${errText.slice(0, 200)}`);
    }
    const items: unknown = await res.json();
    if (!Array.isArray(items) || items.length === 0) return null;
    return items[0] as LinkedinProfile;
  } finally {
    clearTimeout(timeout);
  }
}

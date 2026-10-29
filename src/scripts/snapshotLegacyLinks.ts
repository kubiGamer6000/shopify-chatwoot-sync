/**
 * One-off: sign the `shopify_email_link` values that exist BEFORE the security
 * change, so they can be shown to agents as "suggested (old AI matcher)" and
 * confirmed. Links set afterwards (e.g. planted through the public widget
 * contact API) have no signature and are ignored.
 *
 * Run it ONCE, before merging/deploying, with the production environment
 * (same CHATWOOT_* values and the SAME LINK_CONFIRMATION_SECRET as production):
 *
 *   npx tsx src/scripts/snapshotLegacyLinks.ts           # dry run: counts only
 *   npx tsx src/scripts/snapshotLegacyLinks.ts --apply   # writes the signatures
 *
 * Prints counts only (no emails). Writes only `shopify_email_link_legacy_sig`.
 */
import { env, assertSecuritySecrets } from '../config/env.js';
import { chatwootClient, getContact, mergeContactAttributes } from '../services/chatwoot.js';
import { readLegacyLink, readLinkConfirmation, signLegacyLink } from '../services/contactLink.js';
import { normalizeEmail } from '../security/crypto.js';
import type { ChatwootContact } from '../types/index.js';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  assertSecuritySecrets();
  if (!env.linkConfirmationSecret) throw new Error('LINK_CONFIRMATION_SECRET is required');

  const counts = { scanned: 0, withLink: 0, alreadySigned: 0, sameAsOwnEmail: 0, signed: 0, errors: 0 };
  for (let page = 1; page <= 1000; page++) {
    const res = await chatwootClient.post<{ payload: ChatwootContact[] }>(`/contacts/filter?page=${page}`, {
      payload: [{ attribute_key: 'shopify_email_link', filter_operator: 'is_present', values: [] }],
    });
    const contacts = res.data.payload ?? [];
    if (contacts.length === 0) break;
    for (const c of contacts) {
      counts.scanned++;
      const link = normalizeEmail(c.custom_attributes?.['shopify_email_link'] as string | undefined);
      if (!link) continue;
      counts.withLink++;
      if (readLinkConfirmation(c) || readLegacyLink(c)) {
        counts.alreadySigned++;
        continue;
      }
      if (link === normalizeEmail(c.email)) {
        counts.sameAsOwnEmail++;
        continue;
      }
      if (!apply) {
        counts.signed++;
        continue;
      }
      try {
        const fresh = await getContact(c.id);
        if (!fresh) continue;
        await mergeContactAttributes(c.id, fresh.custom_attributes ?? {}, {
          shopify_email_link_legacy_sig: signLegacyLink(c.id, link),
        });
        counts.signed++;
        await new Promise((r) => setTimeout(r, 300)); // stay under Chatwoot rate limits
      } catch {
        counts.errors++;
      }
    }
  }
  console.log(apply ? 'Applied:' : 'Dry run (use --apply to write):', counts);
}

main().catch((err) => {
  console.error('Snapshot failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

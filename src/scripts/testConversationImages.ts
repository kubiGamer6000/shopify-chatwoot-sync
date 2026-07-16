/**
 * Verifies the customer-image pipeline end-to-end for a conversation:
 *   1. Reads the conversation messages from Chatwoot.
 *   2. Runs gatherCustomerImages() (download + base64, same as the draft flow).
 *   3. Sends the images to Claude and prints what it sees.
 *
 * Requires REAL Chatwoot + Anthropic credentials in the environment (the repo's
 * default .env has placeholders). Run on the deployed app or with real keys:
 *
 *   npx tsx src/scripts/testConversationImages.ts 5793
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { getConversationMessages } from '../services/chatwootConversation.js';
import { gatherCustomerImages } from '../services/attachments.js';
import { toUserContent } from '../services/aiDraft.js';

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error('Usage: tsx src/scripts/testConversationImages.ts <conversationId>');
    process.exit(1);
  }

  console.log(`\nFetching messages for conversation #${id}...`);
  const res = await getConversationMessages(Number(id));
  console.log(`  ${res.payload.length} message(s).`);

  const images = await gatherCustomerImages(res.payload);
  console.log(`\ngatherCustomerImages() -> ${images.length} image(s):`);
  images.forEach((img, i) =>
    console.log(`  [${i + 1}] ${img.mediaType} | ~${Math.round((img.base64.length * 3) / 4 / 1024)} KB`),
  );

  if (images.length === 0) {
    console.log('\nNo customer image attachments found — nothing to send to Claude.');
    process.exit(0);
  }

  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  const content = toUserContent(
    'Describe in detail what you see in the attached customer image(s). Be specific about the product and any visible issue (e.g. a dissolved or damaged gum, a delivered box).',
    images,
  );

  console.log('\nAsking Claude to describe the image(s)...\n');
  const message = await client.messages.create({
    model: env.claudeModel,
    max_tokens: 1024,
    messages: [{ role: 'user', content }],
  });

  const text = message.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  console.log('--- CLAUDE VISION OUTPUT ---');
  console.log(text || '(no text output)');
  console.log('----------------------------\n');
}

main().catch((err) => {
  console.error('Crashed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

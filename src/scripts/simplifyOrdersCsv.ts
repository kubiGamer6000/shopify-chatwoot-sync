/**
 * Flatten Shopify orders_export CSV → one row per order.
 *
 *   tsx src/scripts/simplifyOrdersCsv.ts [input.csv] [output.csv]
 */
import { createReadStream, writeFileSync } from 'fs';
import { parse } from 'csv-parse';
import { env } from '../config/env.js';

const inputPath = process.argv[2] ?? 'orders_export_1.csv';
const outputPath = process.argv[3] ?? 'orders_simple.csv';

type Row = Record<string, string>;

function esc(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function fulfillmentLabel(status: string): string {
  const s = (status || '').trim().toLowerCase();
  if (!s || s === 'unfulfilled') return 'unfulfilled';
  if (s === 'fulfilled') return 'fulfilled';
  return s; // partial, restocked, etc.
}

async function main() {
  const rows: Row[] = [];
  const parser = createReadStream(inputPath).pipe(
    parse({ columns: true, relax_quotes: true, relax_column_count: true }),
  );
  for await (const row of parser) rows.push(row as Row);

  const byOrder = new Map<string, Row>();
  for (const row of rows) {
    const id = (row.Id || '').trim();
    if (!id || byOrder.has(id)) continue;
    byOrder.set(id, row);
  }

  const domain = env.shopifyStoreDomain;
  const out: string[] = [
    ['customer_name', 'order_number', 'phone', 'email', 'shopify_link', 'order_date', 'fulfillment'].join(','),
  ];

  for (const row of byOrder.values()) {
    const name =
      (row['Billing Name'] || row['Shipping Name'] || '').trim();
    const phone =
      (row.Phone || row['Billing Phone'] || row['Shipping Phone'] || '').trim();
    const email = (row.Email || '').trim();
    const orderNumber = (row.Name || '').trim();
    const id = (row.Id || '').trim();
    const date = (row['Created at'] || '').trim();
    const fulfillment = fulfillmentLabel(row['Fulfillment Status'] || '');
    const link = `https://${domain}/admin/orders/${id}`;

    out.push(
      [name, orderNumber, phone, email, link, date, fulfillment].map(esc).join(','),
    );
  }

  writeFileSync(outputPath, out.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${byOrder.size} orders → ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

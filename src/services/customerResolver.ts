import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  fetchCustomerOrders,
  searchCustomerByEmail,
  searchOrderByName,
} from './shopify.js';
import { linkShopifyEmail } from './chatwoot.js';
import type { ShopifyCustomer, ShopifyOrder } from '../types/index.js';

const client = new Anthropic({ apiKey: env.anthropicApiKey });

export interface ResolutionResult {
  // True once a tool located a Shopify customer that actually has orders.
  resolved: boolean;
  shopifyCustomer: ShopifyCustomer | null;
  orders: ShopifyOrder[];
  // The email written to the `shopify_email_link` custom attribute on success.
  linkedEmail: string | null;
}

/**
 * Builds the short, high-signal summary a tool returns to Claude after a
 * successful lookup. Kept compact on purpose — the full, richly-formatted
 * context is rebuilt by the normal draft prompt once resolution succeeds.
 */
function formatCustomerSummary(
  customer: ShopifyCustomer,
  orders: ShopifyOrder[],
): string {
  const name =
    [customer.first_name, customer.last_name].filter(Boolean).join(' ') ||
    'Unknown';
  const orderLines = [...orders]
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .slice(0, 10)
    .map((o) => {
      const date = o.created_at?.split('T')[0] ?? 'N/A';
      const fulfillment = o.fulfillment_status ?? 'unfulfilled';
      return `- ${o.name} | ${date} | ${o.total_price} ${o.currency} | ${o.financial_status ?? 'unknown'} / ${fulfillment}`;
    })
    .join('\n');

  return [
    `MATCH FOUND. Linked this contact to Shopify customer.`,
    `Name: ${name}`,
    `Email: ${customer.email ?? 'Unknown'}`,
    `Total orders: ${orders.length}`,
    orderLines || '(no orders)',
  ].join('\n');
}

const SEARCH_BY_EMAIL_DESC =
  'Look up a Shopify customer by an email address and return their account ' +
  'summary plus order history (order numbers, dates, totals, and fulfilment ' +
  'status). Use this when the customer\'s message contains an email address ' +
  'that is different from the address already on their Chatwoot contact — for ' +
  'example they write "I placed the order with john@gmail.com". Returns a ' +
  'short "not found" message if no Shopify customer exists for that email, or ' +
  'if the customer exists but has never placed an order. On a successful match ' +
  '(a customer that has at least one order) this also permanently links the ' +
  'email to the Chatwoot contact so future lookups resolve automatically. Do ' +
  'not guess an email — only call this with an address the customer actually ' +
  'provided.';

const SEARCH_BY_ORDER_DESC =
  'Look up a Shopify order by its order number (e.g. "#11696" or "11696") and ' +
  'return the associated customer\'s account summary and full order history. ' +
  'Use this when the customer references an order number but their Chatwoot ' +
  'contact is not linked to a Shopify account — for example "where is my order ' +
  '#11696?". Returns a short "not found" message if no order matches the ' +
  'number. On a successful match this also permanently links the order\'s ' +
  'customer email to the Chatwoot contact so future lookups resolve ' +
  'automatically. Accepts the order number with or without the leading "#".';

function buildResolverSystemPrompt(chatwootEmail: string | null): string {
  const knownEmail = chatwootEmail ?? 'unknown';
  return [
    'You are a Shopify lookup assistant for Scandi customer support.',
    '',
    `A customer has written in, but their Chatwoot contact (email: ${knownEmail}) is NOT linked to a Shopify account that has any orders. They likely ordered using a different email, or they have not ordered yet.`,
    '',
    'Your ONLY job is to locate their Shopify account using the tools, but ONLY when the information needed is clearly present in their message:',
    `- If the message clearly contains an email address that is different from "${knownEmail}", call search_customer_by_email with that address.`,
    '- If the message clearly contains an order number (e.g. "#1234", "order 1234"), call search_customer_by_order_number with it.',
    '- If it contains both, prefer the order number.',
    '- If the message contains NEITHER a usable alternate email NOR an order number, do NOT call any tool. Just reply with the single word: NONE',
    '',
    'After a tool reports a successful match, you are done — reply with the single word: DONE',
    'If a tool reports "not found", you may try the other tool if relevant info is available, otherwise reply NONE.',
    '',
    'Do not write any customer-facing message and do not ask the customer questions. Only call tools or reply with NONE / DONE.',
  ].join('\n');
}

/**
 * Runs a small tool-using agent loop (via the SDK Tool Runner) that tries to
 * resolve an unmatched contact to their real Shopify customer using whatever
 * email/order-number they supplied in their message. On success it links the
 * email to the Chatwoot contact and returns the customer + orders so the caller
 * can regenerate the draft with full context. Never throws — returns an
 * unresolved result on any failure.
 */
export async function resolveUnmatchedCustomer(params: {
  contactId: number;
  customerMessage: string;
  chatwootEmail: string | null;
  existingCustomAttributes: Record<string, unknown>;
}): Promise<ResolutionResult> {
  const { contactId, customerMessage, chatwootEmail, existingCustomAttributes } =
    params;

  const result: ResolutionResult = {
    resolved: false,
    shopifyCustomer: null,
    orders: [],
    linkedEmail: null,
  };

  // Captures a successful match and links the email to the Chatwoot contact.
  async function onMatch(
    customer: ShopifyCustomer,
    orders: ShopifyOrder[],
    fallbackEmail: string,
  ): Promise<string> {
    const email = customer.email ?? fallbackEmail;
    result.resolved = true;
    result.shopifyCustomer = customer;
    result.orders = orders;
    result.linkedEmail = email;
    if (email) {
      await linkShopifyEmail(contactId, email, existingCustomAttributes);
    }
    return formatCustomerSummary(customer, orders);
  }

  const searchByEmail = betaZodTool({
    name: 'search_customer_by_email',
    description: SEARCH_BY_EMAIL_DESC,
    inputSchema: z.object({
      email: z
        .string()
        .describe(
          'The email address to search for, exactly as provided by the customer.',
        ),
    }),
    run: async ({ email }) => {
      try {
        const customer = await searchCustomerByEmail(email);
        if (!customer) {
          return `No Shopify customer found with email ${email}.`;
        }
        const orders = await fetchCustomerOrders(customer.id);
        if (orders.length === 0) {
          return `A Shopify customer exists for ${email}, but they have no orders.`;
        }
        return await onMatch(customer, orders, email);
      } catch (err) {
        logger.warn('search_customer_by_email tool failed', {
          email,
          error: err instanceof Error ? err.message : String(err),
        });
        return `Lookup failed for ${email} due to an internal error. Do not retry this email.`;
      }
    },
  });

  const searchByOrder = betaZodTool({
    name: 'search_customer_by_order_number',
    description: SEARCH_BY_ORDER_DESC,
    inputSchema: z.object({
      order_number: z
        .string()
        .describe(
          "The order number from the customer's message, with or without the leading '#'.",
        ),
    }),
    run: async ({ order_number }) => {
      try {
        const order = await searchOrderByName(order_number);
        if (!order || !order.customer) {
          return `No order found matching ${order_number}.`;
        }
        const customerId = order.customer.id;
        const orders = await fetchCustomerOrders(customerId);
        const fallbackEmail = order.customer.email ?? order.email ?? '';
        return await onMatch(order.customer, orders, fallbackEmail);
      } catch (err) {
        logger.warn('search_customer_by_order_number tool failed', {
          order_number,
          error: err instanceof Error ? err.message : String(err),
        });
        return `Lookup failed for order ${order_number} due to an internal error. Do not retry this order number.`;
      }
    },
  });

  try {
    await client.beta.messages.toolRunner({
      model: env.claudeModel,
      max_tokens: 1024,
      max_iterations: 4,
      system: buildResolverSystemPrompt(chatwootEmail),
      tools: [searchByEmail, searchByOrder],
      messages: [
        {
          role: 'user',
          content: `The customer wrote:\n\n"""\n${customerMessage}\n"""`,
        },
      ],
    });
  } catch (err) {
    logger.warn('Customer resolution agent failed', {
      contactId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('Customer resolution finished', {
    contactId,
    resolved: result.resolved,
    orderCount: result.orders.length,
  });

  return result;
}

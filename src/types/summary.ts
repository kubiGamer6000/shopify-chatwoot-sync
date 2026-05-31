export interface CustomerSummary {
  contactId: number;
  email: string | null;
  shopifyCustomerId: string | null;
  conversationId: number | null;
  // Quick 2-4 sentence overview of the customer + order statuses.
  overview: string;
  // Detailed recap of all support conversations (problems, actions, promises).
  history: string;
  model: string;
  generatedAt: string;
}

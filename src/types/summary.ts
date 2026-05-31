export interface ConversationHistoryItem {
  conversationId: number | null;
  // ISO date (YYYY-MM-DD) the conversation started, or null if unknown.
  date: string | null;
  // Conversation status (resolved / open / pending / etc.), or null.
  status: string | null;
  // Detailed recap: the problem/request, what the agent did, promises, outcome.
  summary: string;
}

export interface CustomerSummary {
  contactId: number;
  email: string | null;
  shopifyCustomerId: string | null;
  conversationId: number | null;
  // Quick 2-4 sentence overview of the customer + order statuses.
  overview: string;
  // One entry per support conversation (chronological, oldest first).
  // Older stored summaries may still hold a plain string; readers should
  // tolerate both shapes.
  history: ConversationHistoryItem[] | string;
  model: string;
  generatedAt: string;
}

/**
 * Verifies WHO an agent is, using Chatwoot itself.
 *
 * - `verifyAgentAccessToken`: the agent pastes their personal Chatwoot access
 *   token once (Profile settings → Access Token). We call Chatwoot's
 *   `/api/v1/profile` with it and accept the agent only if they are a member of
 *   CHATWOOT_ACCOUNT_ID. The token is used for this one call and never stored.
 * - `isAgentActive`: on session refresh, checks with the account API token that
 *   the agent still exists in the account.
 */
import axios from 'axios';
import { env } from '../config/env.js';
import { listAgents, type ChatwootAgent } from '../services/chatwoot.js';
import type { AgentIdentity } from './session.js';

interface ProfileResponse {
  id?: number;
  name?: string;
  available_name?: string;
  email?: string;
  role?: string;
  accounts?: { id?: number; role?: string; status?: string }[];
}

export type FetchProfile = (accessToken: string) => Promise<ProfileResponse | null>;

const defaultFetchProfile: FetchProfile = async (accessToken) => {
  try {
    const res = await axios.get<ProfileResponse>(`${env.chatwootBaseUrl}/api/v1/profile`, {
      headers: { api_access_token: accessToken },
      timeout: 10_000,
      // never follow redirects with a credential attached
      maxRedirects: 0,
    });
    return res.data;
  } catch {
    return null;
  }
};

export async function verifyAgentAccessToken(
  accessToken: string,
  fetchProfile: FetchProfile = defaultFetchProfile,
): Promise<AgentIdentity | null> {
  const token = accessToken.trim();
  if (!token || token.length > 512 || /\s/.test(token)) return null;
  const profile = await fetchProfile(token);
  if (!profile || typeof profile.id !== 'number') return null;
  const membership = (profile.accounts ?? []).find(
    (a) => String(a.id) === String(env.chatwootAccountId),
  );
  if (!membership) return null;
  if (membership.status && membership.status !== 'active') return null;
  return {
    id: profile.id,
    name: profile.available_name || profile.name || null,
    email: profile.email ?? null,
    role: membership.role ?? profile.role ?? null,
  };
}

const AGENTS_TTL_MS = 5 * 60 * 1000;
let agentsCache: { at: number; agents: ChatwootAgent[] } | null = null;

export async function isAgentActive(
  agentId: number,
  fetchAgents: () => Promise<ChatwootAgent[]> = listAgents,
  now = Date.now(),
): Promise<ChatwootAgent | null> {
  if (!agentsCache || now - agentsCache.at > AGENTS_TTL_MS) {
    agentsCache = { at: now, agents: await fetchAgents() };
  }
  return agentsCache.agents.find((a) => a.id === agentId) ?? null;
}

/** Test helper. */
export function resetAgentsCache(): void {
  agentsCache = null;
}

import axios from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

interface TokenResponse {
  access_token: string;
  scope: string;
  expires_in: number;
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Obtains an access token using the client_credentials grant.
 * Tokens expire after ~24 hours. We cache and refresh with a 1-hour buffer.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  logger.info('Requesting new Shopify access token via client_credentials');

  const res = await axios.post<TokenResponse>(
    `https://${env.shopifyStoreDomain}/admin/oauth/access_token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.shopifyClientId,
      client_secret: env.shopifyClientSecret,
    }).toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
  );

  cachedToken = res.data.access_token;
  // Refresh 1 hour before actual expiry to avoid mid-request failures
  const bufferMs = 60 * 60 * 1000;
  tokenExpiresAt = now + res.data.expires_in * 1000 - bufferMs;

  logger.info('Shopify access token obtained', {
    scope: res.data.scope,
    expiresIn: `${res.data.expires_in}s`,
  });

  return cachedToken;
}

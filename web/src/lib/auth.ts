/**
 * Dashboard app token comes from the URL query string (?token=…).
 * Chatwoot passes this when loading the iframe — it is NOT baked into the JS bundle.
 *
 * Configure in Chatwoot: Settings → Integrations → Dashboard Apps →
 *   https://<your-domain>/app?token=<DASHBOARD_APP_TOKEN>
 */
let cachedToken: string | null | undefined;

export function getAppToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;

  const fromUrl = new URLSearchParams(window.location.search).get('token');
  cachedToken = fromUrl?.trim() || null;
  return cachedToken;
}

export function hasAppToken(): boolean {
  return getAppToken() !== null;
}

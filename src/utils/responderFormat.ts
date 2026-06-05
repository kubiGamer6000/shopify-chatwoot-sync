/** Appended to every autonomous AgentBot reply sent to the customer. */
export const RESPONDER_SIGNATURE = 'Kind regards,\nScandi Support Team';

/**
 * Strips a trailing sign-off the model may have included despite instructions.
 */
function stripTrailingSignature(body: string): string {
  return body
    .replace(
      /\n*(Kind regards|Best regards|Warm regards|Thanks|Regards)[,\s]*(\n(?:Andrew|Scandi Support(?: Team)?).*)*$/i,
      '',
    )
    .trim();
}

/**
 * Formats an AgentBot reply body for sending: trims the model output, strips any
 * accidental sign-off, and appends the fixed signature block.
 */
export function formatResponderMessage(body: string): string {
  const trimmed = stripTrailingSignature(body.trim());
  return `${trimmed}\n\n${RESPONDER_SIGNATURE}`;
}

'use strict';

/**
 * Transactional email through Brevo (https://developers.brevo.com).
 *
 * Configured from the environment, never from code:
 *   BREVO_API_KEY        the API key (Brevo → SMTP & API → API keys)
 *   BILLING_FROM_EMAIL   a sender on a domain authenticated in Brevo,
 *                        e.g. accounts@centralpass.au
 *   BILLING_FROM_NAME    defaults to "CentralPass"
 *
 * `fetchImpl` is injectable so tests can check the exact request without
 * touching the network.
 */

const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

function brevoConfig(env = process.env) {
  return {
    apiKey: env.BREVO_API_KEY || '',
    fromEmail: env.BILLING_FROM_EMAIL || '',
    fromName: env.BILLING_FROM_NAME || 'CentralPass',
  };
}

function emailConfigured(env = process.env) {
  const config = brevoConfig(env);
  return Boolean(env.BILLING_SEND_ENABLED === 'true' && config.apiKey && config.fromEmail);
}

function splitAddresses(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Send one email. Resolves with { messageId }; rejects with a readable error.
 * attachments: [{ name, content: Buffer }]
 */
async function sendEmail(
  { to, cc, replyTo, subject, html, text, operationKey, attachments = [] },
  { env = process.env, fetchImpl = fetch } = {},
) {
  const config = brevoConfig(env);
  if (!emailConfigured(env)) {
    throw new Error(
      'Sending is disabled. Configure Brevo and set BILLING_SEND_ENABLED=true on the Console service.',
    );
  }
  const toList = splitAddresses(to);
  if (!toList.length) throw new Error('No recipient email address.');

  const body = {
    sender: { email: config.fromEmail, name: config.fromName },
    to: toList.map((email) => ({ email })),
    subject,
    htmlContent: html,
    textContent: text,
  };
  if (operationKey) body.headers = { idempotencyKey: operationKey };
  const ccList = splitAddresses(cc).filter((email) => !toList.includes(email));
  if (ccList.length) body.cc = ccList.map((email) => ({ email }));
  if (replyTo) body.replyTo = { email: replyTo };
  if (attachments.length) {
    body.attachment = attachments.map((a) => ({
      name: a.name,
      content: Buffer.from(a.content).toString('base64'),
    }));
  }

  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key': config.apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      `Brevo rejected the email (${response.status}). Check the Console sender configuration and Brevo activity.`,
    );
    error.definitive =
      response.status >= 400 && response.status < 500 && ![408, 409].includes(response.status);
    throw error;
  }
  if (!payload.messageId)
    throw new Error('Brevo did not return a message ID. Check its activity before resending.');
  return { messageId: payload.messageId };
}

module.exports = { sendEmail, emailConfigured, brevoConfig, splitAddresses };

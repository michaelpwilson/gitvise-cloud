import { GitViseError } from '@gitvise/core';

/**
 * The minimal send surface the gateway needs. Cloudflare Email Service's `SendEmail` binding satisfies it. Tests pass
 * a fake that records messages, so no test needs a real sender.
 */
export interface TransactionalMailer {
  send(message: { to: string; from: string; subject: string; text: string; html: string }): Promise<unknown>;
}

export interface ConfirmationEmail {
  readonly to: string;
  readonly firstName: string;
  readonly link: string;
  readonly expiresInHours: number;
}

/** The text of the email that confirms a new account. Plain text and HTML carry the same link. */
export function confirmationMessage(input: ConfirmationEmail): { subject: string; text: string; html: string } {
  const subject = 'Confirm your GitStrand email';
  const text = [
    `Hi ${input.firstName},`,
    '',
    'Confirm your email address to finish creating your GitStrand account:',
    input.link,
    '',
    `This link expires in ${input.expiresInHours} hours. If you did not sign up, you can ignore this email.`,
  ].join('\n');
  const html = [
    `<p>Hi ${escapeHtml(input.firstName)},</p>`,
    '<p>Confirm your email address to finish creating your GitStrand account:</p>',
    `<p><a href="${escapeHtml(input.link)}">Confirm my email</a></p>`,
    `<p>This link expires in ${input.expiresInHours} hours. If you did not sign up, you can ignore this email.</p>`,
  ].join('');
  return { subject, text, html };
}

/** Sends the confirmation email. Throws `UPSTREAM_FAILURE` when no sender is bound or the send fails. */
export async function sendConfirmationEmail(
  mailer: TransactionalMailer | undefined,
  from: string,
  input: ConfirmationEmail,
): Promise<void> {
  if (mailer === undefined) {
    throw new GitViseError('UPSTREAM_FAILURE', 'email sending is not configured');
  }
  const message = confirmationMessage(input);
  await mailer.send({ to: input.to, from, ...message }).catch((error: unknown) => {
    throw new GitViseError(
      'UPSTREAM_FAILURE',
      `confirmation email could not be sent: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

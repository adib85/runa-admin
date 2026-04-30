import sgMail from "@sendgrid/mail";
import { config } from "@runa/config";

let initialized = false;

function ensureInitialized() {
  if (initialized) return;
  if (!config.sendgrid?.apiKey) {
    throw new Error("SENDGRID_API_KEY is not configured");
  }
  sgMail.setApiKey(config.sendgrid.apiKey);
  initialized = true;
}

export async function sendEmail({ to, subject, html, text }) {
  ensureInitialized();

  const msg = {
    to,
    from: {
      email: config.sendgrid.fromEmail,
      name: config.sendgrid.fromName
    },
    subject,
    text: text || html?.replace(/<[^>]+>/g, "") || "",
    html
  };

  return sgMail.send(msg);
}

export function buildPasswordResetEmail({ resetUrl, email, shop }) {
  const subject = "Reset your Runa password";
  const storeLine = shop
    ? ` for store <strong>${shop}</strong>`
    : "";
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; color: #111;">
      <h1 style="font-size: 22px; font-weight: 600; margin: 0 0 16px;">Reset your password</h1>
      <p style="font-size: 14px; line-height: 1.6; color: #444; margin: 0 0 16px;">
        We received a request to reset the password for the Runa account associated with <strong>${email}</strong>${storeLine}.
      </p>
      <p style="font-size: 14px; line-height: 1.6; color: #444; margin: 0 0 24px;">
        Click the button below to choose a new password. This link will expire in 1 hour.
      </p>
      <p style="margin: 0 0 24px;">
        <a href="${resetUrl}" style="display: inline-block; padding: 12px 20px; background: #111; color: #fff; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 500;">
          Reset password
        </a>
      </p>
      <p style="font-size: 12px; line-height: 1.6; color: #888; margin: 0 0 8px;">
        If the button doesn't work, copy and paste this URL into your browser:
      </p>
      <p style="font-size: 12px; line-height: 1.6; color: #888; word-break: break-all; margin: 0 0 24px;">
        ${resetUrl}
      </p>
      <p style="font-size: 12px; line-height: 1.6; color: #888; margin: 0;">
        If you didn't request a password reset, you can safely ignore this email.
      </p>
    </div>
  `;
  const text = `Reset your Runa password\n\nWe received a request to reset the password for ${email}${shop ? ` (store ${shop})` : ""}.\n\nOpen this link to choose a new password (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`;
  return { subject, html, text };
}

export default { sendEmail, buildPasswordResetEmail };

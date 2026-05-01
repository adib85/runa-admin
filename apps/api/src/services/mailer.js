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

/**
 * Build the internal "new merchant joined" notification for ops/founders.
 * Sent whenever a new shop signs up — either via /register or via the
 * Shopify SSO claim link (first time only).
 */
export function buildNewMerchantEmail({ user, source }) {
  const labelMap = {
    register: "Self-registered via runa-admin",
    "claim-first-time": "Claimed via Shopify SSO link"
  };
  const sourceLabel = labelMap[source] || source || "Unknown";

  const subject = `New Runa merchant: ${user.shop || user.domain || user.email || "(unknown)"}`;
  const rows = [
    ["Source", sourceLabel],
    ["Shop", user.shop || "—"],
    ["Domain", user.domain || "—"],
    ["Platform", user.platform || "—"],
    ["Email", user.email || "—"],
    ["Name", user.name || "—"],
    ["ID", user.id || "—"],
    ["Created", user.createdAt || user.claimedAt || new Date().toISOString()]
  ];

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #111;">
      <h1 style="font-size: 18px; font-weight: 600; margin: 0 0 12px;">New Runa merchant</h1>
      <p style="font-size: 14px; color: #444; margin: 0 0 16px;">
        A new merchant just joined Runa. ${sourceLabel}.
      </p>
      <table style="border-collapse: collapse; font-size: 13px; line-height: 1.5; width: 100%;">
        ${rows
          .map(
            ([k, v]) => `
          <tr>
            <td style="padding: 6px 12px 6px 0; color: #888; vertical-align: top; white-space: nowrap;">${k}</td>
            <td style="padding: 6px 0; color: #111; word-break: break-all;">${v}</td>
          </tr>
        `
          )
          .join("")}
      </table>
    </div>
  `;
  const text = `New Runa merchant\n\n${sourceLabel}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}`;

  return { subject, html, text };
}

/**
 * Fire-and-forget notification — never throws, never delays the caller.
 */
export async function notifyNewMerchant({ user, source }) {
  const to = config.notifications?.newMerchantTo;
  if (!to) return;
  if (!config.sendgrid?.apiKey) return;
  try {
    const { subject, html, text } = buildNewMerchantEmail({ user, source });
    await sendEmail({ to, subject, html, text });
  } catch (err) {
    console.error("notifyNewMerchant failed:", err?.response?.body || err);
  }
}

export default {
  sendEmail,
  buildPasswordResetEmail,
  buildNewMerchantEmail,
  notifyNewMerchant
};

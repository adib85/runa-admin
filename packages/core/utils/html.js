import { stripHtml } from "string-strip-html";

/**
 * HTML processing utilities
 */

/**
 * Strip HTML tags from text
 * @param {string} html - HTML string
 * @returns {string} - Plain text
 */
export function stripHtmlTags(html) {
  if (!html) return "";
  return stripHtml(html).result.trim();
}

/**
 * Convert HTML to simple markdown
 * @param {string} html - HTML string
 * @returns {string} - Markdown text
 */
export function htmlToMarkdown(html) {
  if (!html) return "";

  let text = html;

  // Headers
  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n");
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n");
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n");

  // Bold and italic
  text = text.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, "**$2**");
  text = text.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, "*$2*");

  // Links
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");

  // Lists
  text = text.replace(/<ul[^>]*>/gi, "\n");
  text = text.replace(/<\/ul>/gi, "\n");
  text = text.replace(/<ol[^>]*>/gi, "\n");
  text = text.replace(/<\/ol>/gi, "\n");
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");

  // Paragraphs and line breaks
  text = text.replace(/<p[^>]*>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

/**
 * Decode common HTML entities
 * @param {string} text - Text with HTML entities
 * @returns {string} - Decoded text
 */
export function decodeHtmlEntities(text) {
  const entities = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&ndash;": "–",
    "&mdash;": "—",
    "&lsquo;": "'",
    "&rsquo;": "'",
    "&ldquo;": '"',
    "&rdquo;": '"',
    "&copy;": "©",
    "&reg;": "®",
    "&trade;": "™"
  };

  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replace(new RegExp(entity, "g"), char);
  }

  // Handle numeric entities
  result = result.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(parseInt(code, 10))
  );
  result = result.replace(/&#x([0-9a-f]+);/gi, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );

  return result;
}

/**
 * Extract text content, truncating to max length
 * @param {string} html - HTML string
 * @param {number} maxLength - Maximum length
 * @returns {string} - Truncated plain text
 */
export function extractText(html, maxLength = 1000) {
  const text = stripHtmlTags(html);

  if (text.length <= maxLength) {
    return text;
  }

  // Truncate at word boundary
  const truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > maxLength * 0.8) {
    return truncated.substring(0, lastSpace) + "...";
  }

  return truncated + "...";
}

export default {
  stripHtmlTags,
  htmlToMarkdown,
  decodeHtmlEntities,
  extractText
};

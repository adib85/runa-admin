/**
 * HTML Utilities
 * HTML to Markdown conversion (for Bogas)
 */

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { JSDOM } from "jsdom";
import { stripHtml } from "string-strip-html";

export function convertHtmlToMarkdown(html) {
  if (!html) return '';
  try {
    const dom = new JSDOM(`<body>${html}</body>`);
    const { document } = dom.window;
    const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
    td.use(gfm);
    return td.turndown(document.body.innerHTML).trim();
  } catch (e) {
    return stripHtml(html).result || '';
  }
}

export function stripHtmlTags(html) {
  if (!html) return '';
  return stripHtml(html).result || '';
}

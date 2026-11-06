// Parse the human-readable tgcloud webhook status defensively.
// Never assert deployment success when the output cannot establish the
// subscription of the HTMLBubble handlers. The runtime also independently
// checks Bot API getWebhookInfo before sending widgets.
export function verifyWidgetWebhookReport(raw) {
  const text = String(raw ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const ix = lines.findIndex((line) => /\ballowed[\s_-]*updates?\b/i.test(line));
  if (ix < 0) return { ok: false, reason: 'Webhook status does not show allowed_updates' };

  // The CLI may present allowed_updates inline or as several rows under a
  // heading. Stop at the next status field instead of scanning the whole log.
  const section = [lines[ix]];
  for (let j = ix + 1; j < Math.min(lines.length, ix + 40); j++) {
    const line = lines[j];
    if (/^(?:url|pending|last[\s_-]*error|in[\s_-]*sync|sync[\s_-]*status|status|webhook)\b/i.test(line)) break;
    if (/^[a-z][\w\s_-]*:\s/i.test(line) && !/widget_query|shared_widget_query/.test(line)) break;
    section.push(line);
  }
  const subscribed = section.join(' ');
  for (const kind of ['widget_query', 'shared_widget_query']) {
    if (!new RegExp('(?:^|[^a-z_])' + kind + '(?:$|[^a-z_])', 'i').test(subscribed)) {
      return { ok: false, reason: 'allowed_updates is missing ' + kind };
    }
  }

  if (/out[\s_-]*of[\s_-]*sync|not[\s_-]*in[\s_-]*sync|in[\s_-]*sync\s*[:=]\s*(?:false|no|off|✗|❌)/i.test(text)) {
    return { ok: false, reason: 'Webhook reports out-of-sync status' };
  }
  const aligned = lines.some((line) =>
    /in[\s_-]*sync\s*[:=]\s*(?:yes|true|on|✓|✅)|(?:✓|✅)\s*in[\s_-]*sync|in[\s_-]*sync\s+with\b/i.test(line));
  if (!aligned) return { ok: false, reason: 'Could not confirm In sync: yes' };
  return { ok: true, reason: 'Widget update types subscribed and webhook in sync' };
}

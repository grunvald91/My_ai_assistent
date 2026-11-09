// Public, read-only probe for Telegram Serverless' announced handler kinds.
// No bot credentials are required. It is safe to run on a cheap cron job.
// The /capabilities endpoint is authoritative for the CLI's allowed_names.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function supportsWidgetUpdates(payload) {
  const descriptor = payload?.result ?? payload;
  const dirs = descriptor?.directories;
  const handlers = Array.isArray(dirs) ? dirs.find((d) => d?.name === 'handlers') : null;
  const names = handlers?.allowed_names ?? handlers?.allowedNames;
  return Array.isArray(names) &&
    ['widget_query', 'shared_widget_query'].every((name) => names.includes(name));
}

async function main() {
  let supported = false;
  try {
    const response = await fetch('https://cloud.telegram.org/capabilities', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const payload = await response.json();
    if (payload?.ok === false) throw new Error('Serverless capabilities rejected');
    supported = supportsWidgetUpdates(payload);
    console.log(supported
      ? 'Telegram Serverless advertises both Bot API 10.4 widget update handlers.'
      : 'Telegram Serverless does not yet advertise both widget update handlers.');
  } catch (e) {
    console.warn('Could not verify widget capability; no deployment:', e.message);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, 'supported=' + supported + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

// endpoints/bgjob_done.js — итог фонового ответа от задачи GitHub Actions: бот присылает ответ в чат. Только для владельца.
import { EndpointError } from 'sdk';
import { OWNER_IDS } from '../lib/secrets.js';
import { app } from '../lib/deps.js';
import { parseIdList } from '../lib/util.js';

export default async function (input, ctx) {
  if (!parseIdList(OWNER_IDS).includes(ctx?.initData?.user?.id)) throw new EndpointError('Только для владельца', { code: 'FORBIDDEN' });
  const r = await app.bg.finish({
    job: String(input?.job ?? ''),
    n: Number(input?.n ?? 0),
    finish: input?.finish ?? null,
    usage: input?.usage ?? null,
    model: String(input?.model ?? ''),
    error: input?.error ? String(input.error) : null,
    snote: input?.snote ? String(input.snote) : null,
  });
  if (!r) throw new EndpointError('Неизвестная задача', { code: 'NO_JOB' });
  return { ok: true };
}

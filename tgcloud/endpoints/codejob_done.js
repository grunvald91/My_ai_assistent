// endpoints/codejob_done.js — итог задачи GitHub Actions (/code): бот собирает ответ модели и показывает предпросмотр. Только для владельца.
import { EndpointError } from 'sdk';
import { OWNER_IDS } from '../lib/secrets.js';
import { app } from '../lib/deps.js';
import { parseIdList } from '../lib/util.js';

export default async function (input, ctx) {
  if (!parseIdList(OWNER_IDS).includes(ctx?.initData?.user?.id)) throw new EndpointError('Только для владельца', { code: 'FORBIDDEN' });
  const r = await app.code.finishJob({
    job: String(input?.job ?? ''),
    n: Number(input?.n ?? 0),
    finish: input?.finish ?? null,
    usage: input?.usage ?? null,
    model: String(input?.model ?? ''),
    error: input?.error ? String(input.error) : null,
  });
  if (!r) throw new EndpointError('Неизвестная задача', { code: 'NO_JOB' });
  return { ok: true };
}

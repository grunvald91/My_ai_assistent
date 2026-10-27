// endpoints/bgjob_part.js — принимает кусок ответа тяжёлой модели от задачи GitHub Actions. Только для владельца.
import { EndpointError } from 'sdk';
import { OWNER_IDS } from '../lib/secrets.js';
import { app } from '../lib/deps.js';
import { parseIdList } from '../lib/util.js';

export default async function (input, ctx) {
  if (!parseIdList(OWNER_IDS).includes(ctx?.initData?.user?.id)) throw new EndpointError('Только для владельца', { code: 'FORBIDDEN' });
  const ok = await app.bg.receivePart(String(input?.job ?? ''), Number(input?.i), String(input?.text ?? ''));
  if (!ok) throw new EndpointError('Неизвестная задача', { code: 'NO_JOB' });
  return { ok: true };
}

// endpoints/bgjob_get.js — отдаёт задаче GitHub Actions часть запроса к тяжёлой модели (запрос не передаётся через параметры запуска:
// репозиторий публичный). Только для владельца.
import { EndpointError } from 'sdk';
import { OWNER_IDS } from '../lib/secrets.js';
import { app } from '../lib/deps.js';
import { parseIdList } from '../lib/util.js';

export default async function (input, ctx) {
  if (!parseIdList(OWNER_IDS).includes(ctx?.initData?.user?.id)) throw new EndpointError('Только для владельца', { code: 'FORBIDDEN' });
  const r = await app.bg.getRequest(String(input?.job ?? ''), Number(input?.i ?? 0));
  if (!r) throw new EndpointError('Неизвестная или отменённая задача', { code: 'NO_JOB' });
  return r;
}

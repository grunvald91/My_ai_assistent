// GitHub Actions сообщает Telegram-боту о завершении Superagent задачи.
// tgcloud проверяет initData, дополнительно проверяем владельца; содержимое
// ответа читаем заново напрямую из GitHub, а не принимаем от внешнего вызова.
import { EndpointError } from 'sdk';
import { OWNER_IDS } from '../lib/secrets.js';
import { parseIdList } from '../lib/util.js';
import { app } from '../lib/deps.js';

export default async function(input, ctx) {
  if (!parseIdList(OWNER_IDS).includes(ctx?.initData?.user?.id)) {
    throw new EndpointError('Только для владельца', { code: 'FORBIDDEN' });
  }
  const issue = Number(input?.issue);
  if (!Number.isSafeInteger(issue) || issue < 1) {
    throw new EndpointError('Неверный номер задания', { code: 'INVALID_ISSUE' });
  }
  const ok = await app.superagent.deliver({
    issue,
    commentId: input?.comment_id == null ? null : Number(input.comment_id),
    timeout: input?.timeout === true,
  });
  if (!ok) throw new EndpointError('Нет готового ответа для этой задачи', { code: 'NO_RESULT' });
  return { ok: true };
}

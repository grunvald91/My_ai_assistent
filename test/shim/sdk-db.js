// Локальная замена 'sdk/db': платформенный DSL повторяет Drizzle ORM, поэтому берём настоящий Drizzle.
import { sqliteTable, integer, text, real, numeric, blob, index, uniqueIndex, unique, check, primaryKey } from 'drizzle-orm/sqlite-core';
export {
  eq, ne, gt, gte, lt, lte, like, notLike, isNull, isNotNull, and, or, not,
  between, notBetween, inArray, notInArray, count, sum, avg, min, max, asc, desc, sql,
} from 'drizzle-orm';
export { integer, text, real, numeric, blob, index, uniqueIndex, unique, check, primaryKey };

export const table = (name, columns, extras) => sqliteTable(name, columns, extras);
export const boolean = (name) => integer(name, { mode: 'boolean' });
export const json = (name) => text(name, { mode: 'json' });

// handlers/my_chat_member.js — тонкая обёртка: вся логика в lib/app.js.
import { app } from '../lib/deps.js';

export default async function (payload, ctx) {
  await app.handle('my_chat_member', payload, ctx);
}

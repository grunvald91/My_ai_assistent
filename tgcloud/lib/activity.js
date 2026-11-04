// Visible progress while a Telegram update is being handled.
// Telegram's typing status expires after at most five seconds. On runtimes that
// expose timers, refresh it until the handler finishes. Telegram Serverless may
// not expose timers, so the initial signal must work without them.
export function createTypingHeartbeat(sendTyping, { intervalMs = 4000, timers } = {}) {
  let active = false;
  let pending = false;
  let timer = null;

  async function ping() {
    if (!active || pending) return;
    pending = true;
    try {
      await sendTyping();
    } finally {
      pending = false;
    }
  }

  return {
    async start() {
      if (active) return;
      active = true;
      try {
        await ping();
      } catch {
        // The typing indicator is optional; an API failure must not block replies.
      }
      const set = timers === undefined
        ? (typeof setInterval === 'function' ? setInterval : null)
        : timers?.setInterval;
      if (active && typeof set === 'function') {
        timer = set(() => { void ping().catch(() => {}); }, intervalMs);
        timer?.unref?.(); // Don't keep tests or short-lived Node processes alive.
      }
    },
    stop() {
      active = false;
      const clear = timers === undefined
        ? (typeof clearInterval === 'function' ? clearInterval : null)
        : timers?.clearInterval;
      if (timer !== null && typeof clear === 'function') clear(timer);
      timer = null;
    },
  };
}

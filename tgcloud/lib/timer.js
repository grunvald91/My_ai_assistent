// timer.js — таймер в среде, где нет setTimeout (изолят серверов Telegram).
// Единственное, что там умеет ждать по времени, — Atomics.waitAsync (проверено диагностикой: scripts/diag).
// timeout(ms) → { promise, cancel }: promise выполнится через ms миллисекунд; cancel() снимает ожидание сразу
// (иначе висящее ожидание может задержать завершение вызова бота).
// available() = false → таймера нет совсем (тогда срок проверяется только между порциями данных).

const canAtomics = () => typeof Atomics !== 'undefined' && typeof Atomics.waitAsync === 'function' && typeof SharedArrayBuffer !== 'undefined';

export function available() {
  return typeof setTimeout === 'function' || canAtomics();
}

/** mode: 'auto' (setTimeout, если есть) | 'atomics' (принудительно, для тестов). */
export function timeout(ms, { mode = 'auto' } = {}) {
  const wait = Math.max(0, Math.round(ms));
  if (mode === 'auto' && typeof setTimeout === 'function') {
    let id;
    const promise = new Promise((r) => {
      id = setTimeout(r, wait);
    });
    return { promise, cancel: () => clearTimeout(id) };
  }
  if (!canAtomics()) return { promise: new Promise(() => {}), cancel() {} }; // таймера нет: никогда не срабатывает
  const ia = new Int32Array(new SharedArrayBuffer(4));
  const r = Atomics.waitAsync(ia, 0, 0, wait);
  const promise = r.async ? r.value.then(() => undefined) : Promise.resolve();
  return { promise, cancel: () => Atomics.notify(ia, 0) };
}

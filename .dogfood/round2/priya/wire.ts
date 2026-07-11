// A fake in-process "wire" simulating a Worker postMessage / WebSocket port.
// It carries tagged plain-data messages between a host `send` and a client
// `receive` (and vice-versa), async (queueMicrotask) + structuredClone'd so we
// catch anything non-serializable, and toggleable offline to park delivery.

export type Endpoint = { receive: (m: unknown) => void };

export function makeWire() {
  let host: Endpoint | null = null;
  let client: Endpoint | null = null;
  let connected = true;
  // messages that couldn't be delivered while "offline" (transport down)
  const parkedToClient: unknown[] = [];
  const parkedToHost: unknown[] = [];

  function deliver(target: Endpoint | null, m: unknown, park: unknown[]) {
    const clone = structuredClone(m);
    if (!connected) {
      park.push(clone);
      return;
    }
    queueMicrotask(() => target?.receive(clone));
  }

  return {
    attachHost: (h: Endpoint) => (host = h),
    attachClient: (c: Endpoint) => (client = c),
    // host.send -> client.receive
    hostSend: (m: unknown) => deliver(client, m, parkedToClient),
    // client.send -> host.receive
    clientSend: (m: unknown) => deliver(host, m, parkedToHost),
    setConnected(v: boolean) {
      connected = v;
      if (v) {
        for (const m of parkedToClient.splice(0)) queueMicrotask(() => client?.receive(m));
        for (const m of parkedToHost.splice(0)) queueMicrotask(() => host?.receive(m));
      }
    },
    isConnected: () => connected,
  };
}

// Let all queued microtasks + a few macrotasks flush (loaders are async).
export function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

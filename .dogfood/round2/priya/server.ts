// A fake backend API: source-of-truth tasks per project, a demand-fill fetch,
// and an upstream write sink. Toggle `online` to simulate network loss.

import type { SyncWrite } from '@lenke/sync';

export type Task = { id: string; title: string; done: boolean };

export function makeServer() {
  const data: Record<string, Task[]> = {
    apollo: [
      { id: 'a1', title: 'Wire the transport', done: true },
      { id: 'a2', title: 'Demand-fill collections', done: false },
    ],
    gemini: [{ id: 'g1', title: 'Snapshot warm-boot', done: false }],
    // `ghost` intentionally has no fetch handler → its load will throw.
  };

  return {
    online: true,
    received: [] as SyncWrite[], // writes replicated up via upstream.push
    fetchCalls: [] as string[],

    async fetchTasks(project: string): Promise<Task[]> {
      this.fetchCalls.push(project);
      if (!this.online) throw new Error('network down (fetchTasks)');
      if (!(project in data)) throw new Error(`no such project '${project}'`);
      return structuredClone(data[project]!);
    },

    // The upstream.push target.
    async push(write: SyncWrite): Promise<void> {
      if (!this.online) throw new Error('network down (push)');
      this.received.push(write);
    },
  };
}

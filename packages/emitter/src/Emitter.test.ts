import { describe, expect, mock, test } from 'bun:test';

import { Emitter } from './Emitter.js';
import { EmitterEvent } from './EmitterEvent.js';

const ev = (value: Record<string, any> = { foo: 'bar' }) => new EmitterEvent('foo', value);

describe('Emitter', () => {
  test('it emits', () => {
    const listener = mock();
    const emitter = new Emitter();
    emitter.enable();
    emitter.on('foo', listener);
    emitter.emit(ev());
    expect(listener).toHaveBeenCalledWith(ev());
  });

  test('it starts disabled', () => {
    const listener = mock();
    const emitter = new Emitter();
    emitter.on('foo', listener);
    emitter.emit(ev());
    expect(listener).toHaveBeenCalledTimes(0);
  });

  test('disable() after enable() stops emission', () => {
    const listener = mock();
    const emitter = new Emitter({ enabled: true });
    emitter.on('foo', listener);
    emitter.disable();
    emitter.emit(ev());
    expect(listener).toHaveBeenCalledTimes(0);
  });

  test('we can use convenience events', () => {
    const listener = mock();
    const emitter = new Emitter({ enabled: true });
    emitter.on('foo', listener);
    emitter.emit(emitter.eventFrom('foo', { foo: 'bar' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('on() returns a working unsubscribe and fans out to all listeners', () => {
    const a = mock();
    const b = mock();
    const emitter = new Emitter({ enabled: true });
    const offA = emitter.on('foo', a);
    emitter.on('foo', b);

    emitter.emit(ev());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    emitter.emit(ev());
    expect(a).toHaveBeenCalledTimes(1); // unsubscribed
    expect(b).toHaveBeenCalledTimes(2);
  });

  test('once() fires exactly once then auto-removes', () => {
    const listener = mock();
    const emitter = new Emitter({ enabled: true });
    emitter.once('foo', listener);
    emitter.emit(ev());
    emitter.emit(ev());
    emitter.emit(ev());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('once() can be unsubscribed before it fires', () => {
    const listener = mock();
    const emitter = new Emitter({ enabled: true });
    const off = emitter.once('foo', listener);
    off();
    emitter.emit(ev());
    expect(listener).toHaveBeenCalledTimes(0);
  });

  test('a throwing listener is isolated: the rest still run', () => {
    const errors: unknown[] = [];
    const emitter = new Emitter({ enabled: true, onError: (e) => errors.push(e) });
    const before = mock();
    const after = mock();
    const boom = new Error('boom');

    emitter.on('foo', before);
    emitter.on('foo', () => {
      throw boom;
    });
    emitter.on('foo', after);

    const returned = emitter.emit(ev());
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1); // not stopped by the thrower
    expect(errors).toEqual([boom]); // surfaced via onError, not swallowed
    expect(returned).toEqual(ev()); // emit still returned the event
  });

  test('preventDefault is observable on the returned event and does not stop propagation', () => {
    const emitter = new Emitter({ enabled: true });
    const later = mock();
    emitter.on('foo', (event) => event.preventDefault());
    emitter.on('foo', later);

    const event = emitter.emit(ev());
    expect(event.defaultPrevented).toBe(true); // the caller (e.g. graph) can veto
    expect(later).toHaveBeenCalledTimes(1); // preventDefault != stopPropagation
  });

  test('subscribing during emit does not fire in the current emission (snapshot)', () => {
    const emitter = new Emitter({ enabled: true });
    const added = mock();
    emitter.on('foo', () => {
      emitter.on('foo', added); // re-subscribe mid-dispatch
    });

    emitter.emit(ev()); // must terminate, and `added` must not fire this round
    expect(added).toHaveBeenCalledTimes(0);
    emitter.emit(ev());
    expect(added).toHaveBeenCalledTimes(1);
  });

  test('unsubscribing another listener during emit still runs the snapshot', () => {
    const emitter = new Emitter({ enabled: true });
    const b = mock();
    let offB: () => void = () => {};
    emitter.on('foo', () => offB()); // A removes B mid-dispatch
    offB = emitter.on('foo', b);

    emitter.emit(ev());
    expect(b).toHaveBeenCalledTimes(1); // snapshot: removal doesn't affect this emit
    emitter.emit(ev());
    expect(b).toHaveBeenCalledTimes(1); // ...but it's gone next time
  });
});

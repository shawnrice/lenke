# @lenke/emitter

> A typed, synchronous event emitter with cancelable events and error-isolated dispatch.

Subscribe to named event types and dispatch typed events to their listeners. Events carry a structured payload and support `preventDefault`, so callers can inspect the result after `emit` returns and let listeners veto an action. Reach for it when you need a small, dependency-free emitter whose dispatch never throws and whose events can be canceled.

## Install

```bash
bun add @lenke/emitter
```

## Usage

```ts
import { Emitter, EmitterEvent } from '@lenke/emitter';

// Map each event type to its event variant.
type NodeAdded = EmitterEvent<'node:added', { id: string }>;
type Events = { 'node:added': NodeAdded };

const emitter = new Emitter<'node:added', Events>();

// Subscribe. `on` returns an unsubscribe function.
const off = emitter.on('node:added', (event) => {
  console.log('added', event.value.id);
  // Veto the action; the caller can read this after emit returns.
  if (event.value.id === 'forbidden') {
    event.preventDefault();
  }
});

// A freshly-constructed emitter starts disabled; turn it on to dispatch.
emitter.enable();

// Build an event and emit it. `emit` returns the same event.
const result = emitter.emit(emitter.eventFrom('node:added', { id: 'n1' }));
if (result.defaultPrevented) {
  // a listener vetoed it
}

off(); // stop receiving events
```

## API

### `new Emitter<Key, TypeMap>(options?)`

- `options.enabled` — start enabled. Defaults to `false`; call `enable()` to begin dispatching.
- `options.onError` — `(error, event) => void`, invoked when a listener throws. A throwing listener never stops other listeners and never breaks the caller. If omitted, the error is re-thrown on a microtask.

Methods:

- `on(type, listener)` — subscribe; returns a nullary unsubscribe function.
- `once(type, listener)` — subscribe for a single dispatch, then auto-remove; returns an unsubscribe function.
- `emit(event)` — dispatch `event` to listeners for `event.type`; returns the same event. A no-op when disabled.
- `eventFrom(type, payload)` — construct the `EmitterEvent` for `type` from its payload.
- `enable()` / `disable()` / `isEnabled()` — control and query whether dispatch is active.

### `new EmitterEvent<TType, TValue>(type, value)`

- `type` — the event type string.
- `value` — the structured payload.
- `defaultPrevented` — `false` until a listener calls `preventDefault()`.
- `preventDefault()` — mark the event as vetoed.

## License

Apache-2.0

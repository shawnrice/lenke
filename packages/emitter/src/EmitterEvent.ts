/**
 * An emitted event. Events are **observation-only** — a listener reacts (React
 * re-render, metrics, tracking, an audit journal) but cannot alter or veto the
 * mutation that produced it. Enforcing invariants is a validation/constraint
 * concern, not an event-bus one; keeping the bus a pure notification channel is
 * deliberate (see the graph's mutation methods, which always commit).
 */
export class EmitterEvent<TType extends string, TValue extends Record<string, any>> {
  type: TType;

  value: TValue;

  constructor(type: TType, value: TValue) {
    this.type = type;
    this.value = value;
  }
}

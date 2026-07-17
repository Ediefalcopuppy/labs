import type { ClockEvent } from "./types";

type Subscriber = {
  active: boolean;
  controller: ReadableStreamDefaultController<Uint8Array>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const encoder = new TextEncoder();

function serializePublicEvent(event: ClockEvent): Uint8Array {
  const publicEvent: ClockEvent = {
    type: "planet_tick",
    tick: event.tick,
    advancedBy: event.advancedBy,
    issuedAt: event.issuedAt,
    applied: event.applied,
  };
  return encoder.encode(`data: ${JSON.stringify(publicEvent)}\n\n`);
}

export class ClockEventHub {
  private readonly subscribers = new Set<Subscriber>();
  private closed = false;

  publish(event: ClockEvent): void {
    if (this.closed || this.subscribers.size === 0) return;
    const chunk = serializePublicEvent(event);

    for (const subscriber of [...this.subscribers]) {
      if (!subscriber.active) continue;
      const desiredSize = subscriber.controller.desiredSize;
      if (desiredSize !== null && desiredSize <= 0) {
        this.unsubscribe(subscriber, true);
        continue;
      }
      try {
        subscriber.controller.enqueue(chunk);
      } catch {
        this.unsubscribe(subscriber, false);
      }
    }
  }

  createResponse(signal?: AbortSignal): Response {
    const hub = this;
    let subscriber: Subscriber | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (hub.closed || signal?.aborted) {
          controller.close();
          return;
        }

        subscriber = { active: true, controller, signal };
        if (signal) {
          subscriber.onAbort = () => hub.unsubscribe(subscriber!, true);
          signal.addEventListener("abort", subscriber.onAbort, { once: true });
        }
        hub.subscribers.add(subscriber);
      },
      cancel() {
        if (subscriber) hub.unsubscribe(subscriber, false);
      },
    });

    return new Response(body, {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8",
      },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscriber of [...this.subscribers]) {
      this.unsubscribe(subscriber, true);
    }
  }

  private unsubscribe(subscriber: Subscriber, close: boolean): void {
    if (!subscriber.active) return;
    subscriber.active = false;
    this.subscribers.delete(subscriber);
    if (subscriber.signal && subscriber.onAbort) {
      subscriber.signal.removeEventListener("abort", subscriber.onAbort);
    }
    if (!close) return;
    try {
      subscriber.controller.close();
    } catch {
      // A concurrent abort or reader cancellation already closed this stream.
    }
  }
}

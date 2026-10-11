// The "nestjs-aspect/rxjs" entry point: the return value adapter that lets
// advice follow an Observable. The root entry does not import `rxjs`.

import { isObservable, Observable, type Subscriber } from "rxjs";
import type { ReturnValueAdapter } from "./types";
import { isThenable } from "./util";

/**
 * Runs `advice` and then `deliver`, which sends the pending notification to
 * `subscriber`. Advice that returns a thenable is awaited first. An error
 * the advice throws, or a rejection of what it returns, becomes the error
 * notification instead. Nothing runs for a subscriber that has left: a
 * source that emits synchronously still notifies after `take(1)` closed the
 * subscriber, and that subscription ended by unsubscription.
 */
function notifyAfter(
  subscriber: Subscriber<unknown>,
  advice: () => unknown,
  deliver: () => void,
): void {
  if (subscriber.closed) {
    return;
  }
  let returned: unknown;
  try {
    returned = advice();
  } catch (error) {
    subscriber.error(error);
    return;
  }
  if (isThenable(returned)) {
    returned.then(deliver, (error: unknown) => subscriber.error(error));
    return;
  }
  deliver();
}

/**
 * Follows Observables. Register it in
 * `AspectModule.forRoot({ returnValueAdapters: [observableAdapter] })`.
 *
 * An Observable is lazy, so the adapter subscribes to nothing: it returns an
 * Observable that subscribes to the source once for each of its own
 * subscribers and runs the advice within that subscription. A call whose
 * result is never subscribed runs no after advice, and a result that is
 * subscribed twice runs it twice. Before advice and the code of around
 * advice run when the method is called.
 *
 * - `onSuccess` runs the callback when the source completes, with the last
 *   value it emitted or `undefined` when it emitted none, and then completes.
 * - `onError` runs the callback on the error notification and then delivers
 *   the same error.
 * - `finally` runs the callback once when the subscription ends: before the
 *   completion or the error is delivered, or when the subscriber
 *   unsubscribes first, after the source is torn down.
 *
 * Every value is forwarded as the source emits it. A callback that returns a
 * promise delays the completion or the error until the promise settles, and
 * an error from the callback replaces the notification. On unsubscription
 * nothing is left to notify: an error the callback throws leaves
 * `unsubscribe()` as RxJS reports teardown errors, and a promise it returns
 * is not awaited.
 */
export const observableAdapter: ReturnValueAdapter<Observable<unknown>> = {
  supports(value: unknown): value is Observable<unknown> {
    return isObservable(value);
  },
  onSuccess(value, cb) {
    return new Observable((subscriber) => {
      let last: unknown;
      return value.subscribe({
        next(emitted) {
          last = emitted;
          subscriber.next(emitted);
        },
        error(error: unknown) {
          subscriber.error(error);
        },
        complete() {
          notifyAfter(
            subscriber,
            () => cb(last),
            () => subscriber.complete(),
          );
        },
      });
    });
  },
  onError(value, cb) {
    return new Observable((subscriber) =>
      value.subscribe({
        next(emitted) {
          subscriber.next(emitted);
        },
        error(error: unknown) {
          notifyAfter(
            subscriber,
            () => cb(error),
            () => subscriber.error(error),
          );
        },
        complete() {
          subscriber.complete();
        },
      }),
    );
  },
  finally(value, cb) {
    return new Observable((subscriber) => {
      let ran = false;
      const once = () => {
        ran = true;
        return cb();
      };
      const subscription = value.subscribe({
        next(emitted) {
          subscriber.next(emitted);
        },
        error(error: unknown) {
          notifyAfter(subscriber, once, () => subscriber.error(error));
        },
        complete() {
          notifyAfter(subscriber, once, () => subscriber.complete());
        },
      });
      return () => {
        subscription.unsubscribe();
        if (!ran) {
          once();
        }
      };
    });
  },
};

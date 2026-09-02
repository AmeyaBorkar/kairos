import type { Store } from "throttlekit";
import type { Clock } from "./ports.js";

type SyncStore = Store & { applySync: NonNullable<Store["applySync"]> };

/**
 * Bind a store's notion of *now* to the kernel's.
 *
 * A `Store` carries its own clock and uses it wherever a caller does not supply one. `applySync`
 * takes `now` as an optional argument; `apply` has no such argument at all. So a kernel running on
 * one clock and a store running on another disagree about when state expires — and they disagree
 * silently, because expiry is not an error.
 *
 * The failure that produces is worth spelling out, because it is not the obvious one. An in-memory
 * store keeps a single expiry wheel for *every* key it holds, and advances it on whatever `now` the
 * current call carries. One call made on the store's clock therefore advances the wheel past state
 * that a different call wrote on the kernel's, and evicts it — so the bound that state was
 * enforcing quietly stops holding, on a schedule set by which path happened to run last. Under
 * concurrency it is not even deterministic: the same workload holds the contact cap on one run and
 * leaks past it on the next.
 *
 * So the kernel supplies the missing argument itself, once, for every ledger it builds on the
 * store. Two clocks are the normal case rather than an exotic one — any test on a `ManualClock`
 * against a default `MemoryStore` has two, and so does any deployment that hands the kernel a store
 * it constructed earlier without threading a clock through it.
 *
 * `apply` is routed through `applySync` rather than left alone, because a store offering the
 * synchronous path has already promised the read-modify-write is atomic without awaiting; taking it
 * changes nothing but which clock stamps the result. A store with no synchronous path — Redis,
 * Postgres — is returned untouched, and is sound for a different reason: it is only ever paired
 * with a kernel on `systemClock`, which is the clock it already keeps.
 */
export function onKernelClock(store: Store, clock: Clock): Store {
  if (store.applySync === undefined) return store;
  // Narrowed rather than reached through `Function.prototype.call`, which erases a generic method's
  // type parameters and would collapse every transform's result to `unknown`.
  const sync = store as SyncStore;

  const pinned: Store = {
    apply(key, transform) {
      return Promise.resolve(sync.applySync(key, transform, clock.now()));
    },
    applySync(key, transform, now) {
      return sync.applySync(key, transform, now ?? clock.now());
    },
    reset(key) {
      return store.reset(key);
    },
  };

  if (store.resetSync !== undefined) {
    pinned.resetSync = (key) => {
      sync.resetSync?.(key);
    };
  }
  if (store.close !== undefined) pinned.close = () => sync.close?.() ?? Promise.resolve();
  return pinned;
}

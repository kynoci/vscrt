import * as assert from "assert";
import {
  Clock,
  CRTPassphraseService,
  autoLockModeToMs,
  parseAutoLockMode,
} from "../config/vscrtPassphrase";
import {
  InMemorySecretStorage,
  LIGHT_ARGON_PARAMS,
  queueInputBoxResponses,
  resetVscodeStub,
  setInputBoxResponse,
} from "./testUtils";

const PASSPHRASE = "correct-horse-battery-staple";

/**
 * Fake clock that records scheduled timers and lets the test fire them
 * deterministically. The service only ever has one timer live at a time,
 * so we keep it simple: `pending` is the most recently-scheduled callback.
 */
class FakeClock implements Clock {
  pending: { cb: () => void; ms: number; handle: { id: number } } | undefined;
  clearedHandles: Array<{ id: number }> = [];
  private nextId = 1;

  setTimeout(cb: () => void, ms: number): { id: number } {
    const handle = { id: this.nextId++ };
    this.pending = { cb, ms, handle };
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.clearedHandles.push(handle as { id: number });
    if (
      this.pending &&
      (this.pending.handle as { id: number }).id ===
        (handle as { id: number }).id
    ) {
      this.pending = undefined;
    }
  }

  /** Fire the pending timer synchronously. No-op if none. */
  fire(): void {
    const p = this.pending;
    this.pending = undefined;
    p?.cb();
  }

  hasPending(): boolean {
    return this.pending !== undefined;
  }
}

describe("parseAutoLockMode", () => {
  it("accepts all six valid modes", () => {
    for (const m of [
      "never",
      "5min",
      "15min",
      "30min",
      "1hour",
      "onFocusLost",
    ] as const) {
      assert.strictEqual(parseAutoLockMode(m), m);
    }
  });

  it("falls back to 15min for unknown or undefined values", () => {
    assert.strictEqual(parseAutoLockMode(undefined), "15min");
    assert.strictEqual(parseAutoLockMode(""), "15min");
    assert.strictEqual(parseAutoLockMode("nonsense"), "15min");
  });
});

describe("autoLockModeToMs", () => {
  it("returns correct ms for time-based modes", () => {
    assert.strictEqual(autoLockModeToMs("5min"), 5 * 60_000);
    assert.strictEqual(autoLockModeToMs("15min"), 15 * 60_000);
    assert.strictEqual(autoLockModeToMs("30min"), 30 * 60_000);
    assert.strictEqual(autoLockModeToMs("1hour"), 60 * 60_000);
  });

  it("returns undefined for 'never' and 'onFocusLost'", () => {
    assert.strictEqual(autoLockModeToMs("never"), undefined);
    assert.strictEqual(autoLockModeToMs("onFocusLost"), undefined);
  });
});

describe("CRTPassphraseService idle auto-lock", () => {
  beforeEach(() => {
    resetVscodeStub();
  });

  it("schedules a timer after the first unlock when idle timeout is set", async () => {
    const clock = new FakeClock();
    const storage = new InMemorySecretStorage();
    const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS, { clock });
    svc.setIdleTimeout(15 * 60_000);

    assert.strictEqual(clock.hasPending(), false, "no timer before unlock");

    queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
    await svc.seal("payload");

    assert.strictEqual(clock.hasPending(), true, "timer scheduled after unlock");
    assert.strictEqual(clock.pending?.ms, 15 * 60_000);
  });

  it("firing the timer clears the cached key and locks the session", async () => {
    const clock = new FakeClock();
    const storage = new InMemorySecretStorage();
    const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS, { clock });
    svc.setIdleTimeout(5 * 60_000);

    queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
    const ciphertext = await svc.seal("payload");

    // Fire the idle timer.
    clock.fire();

    // Subsequent unseal should have to re-prompt → we dismiss the prompt
    // to prove the cache is gone.
    setInputBoxResponse(undefined);
    await assert.rejects(() => svc.unseal(ciphertext));
  });

  it("resets an in-flight timer on every seal/unseal (activity debounces)", async () => {
    const clock = new FakeClock();
    const storage = new InMemorySecretStorage();
    const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS, { clock });
    svc.setIdleTimeout(5 * 60_000);

    queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
    await svc.seal("one"); // unlock + timer #1
    const firstHandle = clock.pending?.handle;
    await svc.seal("two"); // should clear #1 and schedule #2

    assert.ok(firstHandle, "first timer scheduled");
    assert.ok(
      clock.clearedHandles.some(
        (h) => h.id === (firstHandle as { id: number }).id,
      ),
      "first timer was cleared",
    );
    assert.ok(clock.hasPending(), "a fresh timer replaces it");
  });

  it("lock() cancels the pending timer", async () => {
    const clock = new FakeClock();
    const storage = new InMemorySecretStorage();
    const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS, { clock });
    svc.setIdleTimeout(5 * 60_000);

    queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
    await svc.seal("payload");
    assert.strictEqual(clock.hasPending(), true);

    svc.lock();
    assert.strictEqual(clock.hasPending(), false);
  });

  it("setIdleTimeout(undefined) cancels the pending timer and disables auto-lock", async () => {
    const clock = new FakeClock();
    const storage = new InMemorySecretStorage();
    const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS, { clock });
    svc.setIdleTimeout(5 * 60_000);

    queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
    await svc.seal("payload");
    assert.strictEqual(clock.hasPending(), true);

    svc.setIdleTimeout(undefined);
    assert.strictEqual(clock.hasPending(), false);

    // Further activity should not re-schedule.
    await svc.seal("another");
    assert.strictEqual(clock.hasPending(), false);
  });

  it("setIdleTimeout(ms) while locked defers the timer until the next unlock", async () => {
    const clock = new FakeClock();
    const storage = new InMemorySecretStorage();
    const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS, { clock });

    // Configure before unlocking.
    svc.setIdleTimeout(30 * 60_000);
    assert.strictEqual(clock.hasPending(), false, "no timer without a key");

    queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
    await svc.seal("payload");
    assert.strictEqual(clock.hasPending(), true, "unlock starts the timer");
    assert.strictEqual(clock.pending?.ms, 30 * 60_000);
  });

  it("reconfiguring to a different timeout immediately replaces the pending timer", async () => {
    const clock = new FakeClock();
    const storage = new InMemorySecretStorage();
    const svc = new CRTPassphraseService(storage, LIGHT_ARGON_PARAMS, { clock });
    svc.setIdleTimeout(5 * 60_000);

    queueInputBoxResponses([PASSPHRASE, PASSPHRASE]);
    await svc.seal("payload");
    assert.strictEqual(clock.pending?.ms, 5 * 60_000);

    svc.setIdleTimeout(60 * 60_000);
    assert.strictEqual(clock.pending?.ms, 60 * 60_000, "new timeout applies");
  });
});

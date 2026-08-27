import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ASAP_LEAD_TIME_MINUTES,
  buildDeliveryWindow,
  DeliveryWindowError,
  MINUTE_MS,
  transitMinutes,
  validateDeliveryWindow,
} from "../windows.ts";

const NOW = new Date("2026-03-02T12:00:00.000Z");
const minutesFromNow = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE_MS);

/** duration 45 = 12 min to the store + a 33 min transit leg. */
const QUOTE = { duration: 45, pickup_duration: 12 };

describe("transitMinutes", () => {
  it("is duration minus pickup_duration, not the full duration", () => {
    assert.strictEqual(transitMinutes(QUOTE), 33);
  });

  it("never goes negative", () => {
    assert.strictEqual(transitMinutes({ duration: 5, pickup_duration: 20 }), 0);
  });
});

describe("ASAP", () => {
  it("sends nothing at all when the store needs no prep time", () => {
    const { window } = buildDeliveryWindow({ mode: "asap", now: NOW });
    assert.deepStrictEqual(window, {});
  });

  it("sends pickup_ready_dt alone when prep time is needed, never the other three", () => {
    const { window } = buildDeliveryWindow({ mode: "asap", now: NOW, prepMinutes: 20 });
    assert.strictEqual(window.pickup_ready_dt, minutesFromNow(20).toISOString());
    assert.strictEqual(window.pickup_deadline_dt, undefined);
    assert.strictEqual(window.dropoff_ready_dt, undefined);
    assert.strictEqual(window.dropoff_deadline_dt, undefined);
  });
});

describe("scheduled food", () => {
  it("derives pickup_ready_dt by subtracting the transit leg only", () => {
    const promised = minutesFromNow(180);
    const { window, effectiveMode } = buildDeliveryWindow({
      mode: "scheduled_food",
      now: NOW,
      promisedDropoffAt: promised,
      quote: QUOTE,
    });

    assert.strictEqual(effectiveMode, "scheduled_food");
    // 180 - 33 = 147 minutes from now. Subtracting the full 45 min duration
    // would give 135 and send the courier to the store 12 minutes early.
    assert.strictEqual(window.pickup_ready_dt, minutesFromNow(147).toISOString());
    assert.notStrictEqual(minutesFromNow(147).toISOString(), minutesFromNow(135).toISOString());
  });

  it("sends only pickup_ready_dt, keeping the same shape as ASAP", () => {
    const { window } = buildDeliveryWindow({
      mode: "scheduled_food",
      now: NOW,
      promisedDropoffAt: minutesFromNow(180),
      quote: QUOTE,
    });
    assert.deepStrictEqual(Object.keys(window), ["pickup_ready_dt"]);
  });

  it("refuses to run without a fresh quote", () => {
    assert.throws(
      () =>
        buildDeliveryWindow({
          mode: "scheduled_food",
          now: NOW,
          promisedDropoffAt: minutesFromNow(180),
        }),
      DeliveryWindowError,
    );
  });
});

describe("scheduled retail", () => {
  it("sends all four timestamps", () => {
    const { window } = buildDeliveryWindow({
      mode: "scheduled_retail",
      now: NOW,
      promisedDropoffAt: minutesFromNow(300),
      promisedDropoffEndAt: minutesFromNow(360),
      quote: QUOTE,
    });

    assert.deepStrictEqual(Object.keys(window).sort(), [
      "dropoff_deadline_dt",
      "dropoff_ready_dt",
      "pickup_deadline_dt",
      "pickup_ready_dt",
    ]);
  });

  it("produces a window that satisfies every documented constraint", () => {
    const { window } = buildDeliveryWindow({
      mode: "scheduled_retail",
      now: NOW,
      promisedDropoffAt: minutesFromNow(300),
      promisedDropoffEndAt: minutesFromNow(360),
      quote: QUOTE,
    });

    const at = (value?: string) => new Date(value!).getTime();

    // pickup window >= 10 min
    assert.ok((at(window.pickup_deadline_dt) - at(window.pickup_ready_dt)) / MINUTE_MS >= 10);
    // dropoff_ready_dt at or before pickup_deadline_dt
    assert.ok(at(window.dropoff_ready_dt) <= at(window.pickup_deadline_dt));
    // dropoff window >= 20 min
    assert.ok((at(window.dropoff_deadline_dt) - at(window.dropoff_ready_dt)) / MINUTE_MS >= 20);
    // dropoff deadline at or after pickup deadline
    assert.ok(at(window.dropoff_deadline_dt) >= at(window.pickup_deadline_dt));

    assert.doesNotThrow(() => validateDeliveryWindow(window, NOW));
  });

  it("widens a too-narrow promised window up to the 20 minute minimum", () => {
    const { window } = buildDeliveryWindow({
      mode: "scheduled_retail",
      now: NOW,
      promisedDropoffAt: minutesFromNow(300),
      promisedDropoffEndAt: minutesFromNow(305),
      quote: QUOTE,
    });
    assert.strictEqual(window.dropoff_deadline_dt, minutesFromNow(320).toISOString());
  });
});

describe("short lead times", () => {
  it("falls back to ASAP under the 90 minute threshold, whatever mode was asked for", () => {
    const { window, effectiveMode, note } = buildDeliveryWindow({
      mode: "scheduled_retail",
      now: NOW,
      promisedDropoffAt: minutesFromNow(ASAP_LEAD_TIME_MINUTES - 15),
      quote: QUOTE,
      prepMinutes: 10,
    });

    assert.strictEqual(effectiveMode, "asap");
    assert.deepStrictEqual(Object.keys(window), ["pickup_ready_dt"]);
    assert.ok(note?.includes("ASAP"));
  });
});

describe("validateDeliveryWindow", () => {
  /** Assert that a window is rejected with a specific documented error code. */
  function assertRejectedWith(code: string, window: Parameters<typeof validateDeliveryWindow>[0]) {
    assert.throws(
      () => validateDeliveryWindow(window, NOW),
      (error: unknown) => {
        assert.ok(error instanceof DeliveryWindowError);
        assert.strictEqual(error.code, code);
        return true;
      },
    );
  }

  it("rejects a pickup window under 10 minutes", () => {
    assertRejectedWith("pickup_window_too_small", {
      pickup_ready_dt: minutesFromNow(60).toISOString(),
      pickup_deadline_dt: minutesFromNow(65).toISOString(),
    });
  });

  it("rejects a pickup_ready_dt in the past", () => {
    assertRejectedWith("pickup_ready_too_early", {
      pickup_ready_dt: minutesFromNow(-5).toISOString(),
    });
  });

  it("rejects a pickup_ready_dt more than 30 days out", () => {
    assertRejectedWith("pickup_ready_too_late", {
      pickup_ready_dt: minutesFromNow(31 * 24 * 60).toISOString(),
    });
  });

  it("rejects a dropoff window under 20 minutes", () => {
    assertRejectedWith("dropoff_deadline_too_early", {
      dropoff_ready_dt: minutesFromNow(120).toISOString(),
      dropoff_deadline_dt: minutesFromNow(130).toISOString(),
    });
  });

  it("rejects dropoff_ready_dt after pickup_deadline_dt", () => {
    assertRejectedWith("dropoff_ready_after_pickup_deadline", {
      pickup_ready_dt: minutesFromNow(60).toISOString(),
      pickup_deadline_dt: minutesFromNow(80).toISOString(),
      dropoff_ready_dt: minutesFromNow(90).toISOString(),
      dropoff_deadline_dt: minutesFromNow(130).toISOString(),
    });
  });
});

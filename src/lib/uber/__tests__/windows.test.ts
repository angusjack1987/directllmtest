import { describe, expect, it } from "vitest";
import {
  ASAP_LEAD_TIME_MINUTES,
  buildDeliveryWindow,
  DeliveryWindowError,
  MINUTE_MS,
  transitMinutes,
  validateDeliveryWindow,
} from "../windows";

const NOW = new Date("2026-03-02T12:00:00.000Z");
const minutesFromNow = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE_MS);

/** duration 45 = 12 min to the store + a 33 min transit leg. */
const QUOTE = { duration: 45, pickup_duration: 12 };

describe("transitMinutes", () => {
  it("is duration minus pickup_duration, not the full duration", () => {
    expect(transitMinutes(QUOTE)).toBe(33);
  });

  it("never goes negative", () => {
    expect(transitMinutes({ duration: 5, pickup_duration: 20 })).toBe(0);
  });
});

describe("ASAP", () => {
  it("sends nothing at all when the store needs no prep time", () => {
    const { window } = buildDeliveryWindow({ mode: "asap", now: NOW });
    expect(window).toEqual({});
  });

  it("sends pickup_ready_dt alone when prep time is needed, never the other three", () => {
    const { window } = buildDeliveryWindow({ mode: "asap", now: NOW, prepMinutes: 20 });
    expect(window.pickup_ready_dt).toBe(minutesFromNow(20).toISOString());
    expect(window.pickup_deadline_dt).toBeUndefined();
    expect(window.dropoff_ready_dt).toBeUndefined();
    expect(window.dropoff_deadline_dt).toBeUndefined();
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

    expect(effectiveMode).toBe("scheduled_food");
    // 180 - 33 = 147 minutes from now. Subtracting the full 45 min duration
    // would give 135 and send the courier to the store 12 minutes early.
    expect(window.pickup_ready_dt).toBe(minutesFromNow(147).toISOString());
    expect(minutesFromNow(147).toISOString()).not.toBe(minutesFromNow(135).toISOString());
  });

  it("sends only pickup_ready_dt, keeping the same shape as ASAP", () => {
    const { window } = buildDeliveryWindow({
      mode: "scheduled_food",
      now: NOW,
      promisedDropoffAt: minutesFromNow(180),
      quote: QUOTE,
    });
    expect(Object.keys(window)).toEqual(["pickup_ready_dt"]);
  });

  it("refuses to run without a fresh quote", () => {
    expect(() =>
      buildDeliveryWindow({
        mode: "scheduled_food",
        now: NOW,
        promisedDropoffAt: minutesFromNow(180),
      }),
    ).toThrow(DeliveryWindowError);
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

    expect(Object.keys(window).sort()).toEqual([
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
    expect((at(window.pickup_deadline_dt) - at(window.pickup_ready_dt)) / MINUTE_MS).toBeGreaterThanOrEqual(10);
    // dropoff_ready_dt at or before pickup_deadline_dt
    expect(at(window.dropoff_ready_dt)).toBeLessThanOrEqual(at(window.pickup_deadline_dt));
    // dropoff window >= 20 min
    expect((at(window.dropoff_deadline_dt) - at(window.dropoff_ready_dt)) / MINUTE_MS).toBeGreaterThanOrEqual(20);
    // dropoff deadline at or after pickup deadline
    expect(at(window.dropoff_deadline_dt)).toBeGreaterThanOrEqual(at(window.pickup_deadline_dt));

    expect(() => validateDeliveryWindow(window, NOW)).not.toThrow();
  });

  it("widens a too-narrow promised window up to the 20 minute minimum", () => {
    const { window } = buildDeliveryWindow({
      mode: "scheduled_retail",
      now: NOW,
      promisedDropoffAt: minutesFromNow(300),
      promisedDropoffEndAt: minutesFromNow(305),
      quote: QUOTE,
    });
    expect(window.dropoff_deadline_dt).toBe(minutesFromNow(320).toISOString());
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

    expect(effectiveMode).toBe("asap");
    expect(Object.keys(window)).toEqual(["pickup_ready_dt"]);
    expect(note).toContain("ASAP");
  });
});

describe("validateDeliveryWindow", () => {
  it("rejects a pickup window under 10 minutes", () => {
    expect(() =>
      validateDeliveryWindow(
        {
          pickup_ready_dt: minutesFromNow(60).toISOString(),
          pickup_deadline_dt: minutesFromNow(65).toISOString(),
        },
        NOW,
      ),
    ).toThrow(/pickup_window_too_small|at least 10 min/);
  });

  it("rejects a pickup_ready_dt in the past", () => {
    try {
      validateDeliveryWindow({ pickup_ready_dt: minutesFromNow(-5).toISOString() }, NOW);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as DeliveryWindowError).code).toBe("pickup_ready_too_early");
    }
  });

  it("rejects a pickup_ready_dt more than 30 days out", () => {
    try {
      validateDeliveryWindow({ pickup_ready_dt: minutesFromNow(31 * 24 * 60).toISOString() }, NOW);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as DeliveryWindowError).code).toBe("pickup_ready_too_late");
    }
  });

  it("rejects a dropoff window under 20 minutes", () => {
    try {
      validateDeliveryWindow(
        {
          dropoff_ready_dt: minutesFromNow(120).toISOString(),
          dropoff_deadline_dt: minutesFromNow(130).toISOString(),
        },
        NOW,
      );
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as DeliveryWindowError).code).toBe("dropoff_deadline_too_early");
    }
  });

  it("rejects dropoff_ready_dt after pickup_deadline_dt", () => {
    try {
      validateDeliveryWindow(
        {
          pickup_ready_dt: minutesFromNow(60).toISOString(),
          pickup_deadline_dt: minutesFromNow(80).toISOString(),
          dropoff_ready_dt: minutesFromNow(90).toISOString(),
          dropoff_deadline_dt: minutesFromNow(130).toISOString(),
        },
        NOW,
      );
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as DeliveryWindowError).code).toBe("dropoff_ready_after_pickup_deadline");
    }
  });
});

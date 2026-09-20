import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEWPORT_SPECS,
  DEVICE_CLASSES,
  describeViewport,
  deviceClassForWidth,
  parseDeviceList,
  parseViewport,
  parseViewportList,
  viewportsForDevices,
} from "../src/index.js";

describe("parseViewport", () => {
  it("parses WxH and WxH@DPR and names the device class", () => {
    expect(parseViewport("390x844")).toEqual({
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      label: "390x844@1",
      device: "mobile",
    });
    expect(parseViewport("390x844@3").deviceScaleFactor).toBe(3);
    expect(parseViewport("768x1024").device).toBe("tablet");
    expect(parseViewport("1280x800").device).toBe("desktop");
  });

  it("rejects malformed specs", () => {
    expect(() => parseViewport("390x")).toThrow(/Invalid viewport/);
    expect(() => parseViewport("10x10")).toThrow(/out of supported range/);
  });
});

describe("device classes", () => {
  it("offers mobile, tablet, and desktop, each with its own sizes", () => {
    expect(DEVICE_CLASSES.map((device) => device.id)).toEqual(["mobile", "tablet", "desktop"]);
    for (const device of DEVICE_CLASSES) {
      expect(device.viewports.length).toBeGreaterThan(1);
      for (const spec of device.viewports) {
        expect(deviceClassForWidth(parseViewport(spec).width), spec).toBe(device.id);
      }
    }
    expect(new Set(DEFAULT_VIEWPORT_SPECS).size).toBe(DEFAULT_VIEWPORT_SPECS.length);
  });

  it("classifies arbitrary widths by the same thresholds", () => {
    expect(deviceClassForWidth(320)).toBe("mobile");
    expect(deviceClassForWidth(599)).toBe("mobile");
    expect(deviceClassForWidth(600)).toBe("tablet");
    expect(deviceClassForWidth(1199)).toBe("tablet");
    expect(deviceClassForWidth(1200)).toBe("desktop");
    expect(deviceClassForWidth(3840)).toBe("desktop");
  });

  it("describes a size by device class and pixels", () => {
    expect(describeViewport(parseViewport("390x844"))).toBe("Mobile 390×844");
    expect(describeViewport(parseViewport("390x844@3"))).toBe("Mobile 390×844 @3x");
    expect(describeViewport({ width: 1920, height: 1080 })).toBe("Desktop 1920×1080");
  });

  it("parses a device list in any order, without duplicates", () => {
    expect(parseDeviceList("desktop, mobile,desktop")).toEqual(["mobile", "desktop"]);
    expect(parseDeviceList("Tablet")).toEqual(["tablet"]);
    expect(() => parseDeviceList("phone")).toThrow(/Unknown device class "phone"/);
    expect(() => parseDeviceList(" , ")).toThrow(/Device list is empty/);
  });

  it("expands device classes to their catalogue sizes", () => {
    const mobile = DEVICE_CLASSES.find((device) => device.id === "mobile")!;
    expect(viewportsForDevices(["mobile"]).map((viewport) => viewport.label))
      .toEqual(mobile.viewports.map((spec) => `${spec}@1`));
    expect(viewportsForDevices(["mobile", "desktop"]).every((viewport) => viewport.device !== "tablet")).toBe(true);
    expect(viewportsForDevices(["mobile", "tablet", "desktop"]).map((viewport) => viewport.label))
      .toEqual(parseViewportList(undefined).map((viewport) => viewport.label));
  });
});

describe("parseViewportList", () => {
  it("defaults to every device class", () => {
    const list = parseViewportList(undefined);
    expect(list.map((viewport) => viewport.label)).toEqual(
      [...DEFAULT_VIEWPORT_SPECS].map((spec) =>
        spec.includes("@") ? spec : `${spec}@1`,
      ),
    );
  });

  it("parses a custom comma list", () => {
    expect(
      parseViewportList("360x800, 1920x1080@2").map(
        (viewport) => viewport.label,
      ),
    ).toEqual(["360x800@1", "1920x1080@2"]);
  });
});

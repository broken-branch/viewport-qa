import type { DeviceClass, ViewportSpec } from "@vqa/contract";

export interface DeviceClassSpec {
  id: DeviceClass;
  /** Human name shown on the launch page and in reports. */
  label: string;
  /** Current top sizes for the class, narrowest first; DPR 1 unless the spec says otherwise. */
  viewports: readonly string[];
}

/**
 * The device classes a reviewer picks from. Each lists the most common CSS
 * viewport sizes for the class today; DPR variants are opt-in via the spec
 * syntax (WxH@DPR). Desktop covers high resolutions too; there is no
 * separate "large" class.
 */
export const DEVICE_CLASSES: readonly DeviceClassSpec[] = [
  { id: "mobile", label: "Mobile", viewports: ["360x800", "390x844", "430x932"] },
  { id: "tablet", label: "Tablet", viewports: ["768x1024", "820x1180", "1024x1366"] },
  { id: "desktop", label: "Desktop", viewports: ["1366x768", "1536x864", "1920x1080", "2560x1440"] },
];

export const DEVICE_CLASS_IDS: readonly DeviceClass[] = DEVICE_CLASSES.map((device) => device.id);

/** Every catalogue size, in class order: what a scan uses when neither --devices nor --viewports is given. */
export const DEFAULT_VIEWPORT_SPECS: readonly string[] = DEVICE_CLASSES.flatMap((device) => [...device.viewports]);

/** Widths at which a viewport stops reading as a phone, then as a tablet. */
const TABLET_MIN_WIDTH = 600;
const DESKTOP_MIN_WIDTH = 1200;

/** The class an arbitrary width stands in for; the catalogue sizes agree with this rule. */
export function deviceClassForWidth(width: number): DeviceClass {
  if (width < TABLET_MIN_WIDTH) return "mobile";
  if (width < DESKTOP_MIN_WIDTH) return "tablet";
  return "desktop";
}

export function deviceClassLabel(device: DeviceClass): string {
  return DEVICE_CLASSES.find((entry) => entry.id === device)?.label ?? device;
}

/** Human name for a capture size: "Mobile 390×844", with " @3x" when the DPR is not 1. */
export function describeViewport(viewport: {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  device?: DeviceClass;
}): string {
  const device = viewport.device ?? deviceClassForWidth(viewport.width);
  const scale = viewport.deviceScaleFactor ?? 1;
  return `${deviceClassLabel(device)} ${viewport.width}×${viewport.height}${scale === 1 ? "" : ` @${scale}x`}`;
}

export function parseViewport(spec: string): ViewportSpec {
  const match = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(spec.trim());
  if (!match) {
    throw new Error(
      `Invalid viewport spec "${spec}" (expected WIDTHxHEIGHT or WIDTHxHEIGHT@DPR, e.g. 390x844@3)`,
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const deviceScaleFactor = match[3] ? Number(match[3]) : 1;
  if (width < 100 || height < 100 || width > 10000 || height > 10000) {
    throw new Error(`Viewport ${spec} out of supported range (100..10000)`);
  }
  return {
    width,
    height,
    deviceScaleFactor,
    label: `${width}x${height}@${deviceScaleFactor}`,
    device: deviceClassForWidth(width),
  };
}

export function parseViewportList(list: string | undefined): ViewportSpec[] {
  const specs = list
    ? list
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [...DEFAULT_VIEWPORT_SPECS];
  if (specs.length === 0) throw new Error("Viewport list is empty");
  return specs.map(parseViewport);
}

/** Parse a comma list of device classes, e.g. "mobile,desktop"; order and duplicates do not matter. */
export function parseDeviceList(list: string): DeviceClass[] {
  const names = list
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) throw new Error("Device list is empty");
  const unknown = names.filter((name) => !DEVICE_CLASS_IDS.includes(name as DeviceClass));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown device class "${unknown[0]}" (expected a comma-separated list of ${DEVICE_CLASS_IDS.join(", ")})`,
    );
  }
  return DEVICE_CLASS_IDS.filter((id) => names.includes(id));
}

/** Every catalogue size for the given classes, in catalogue order. */
export function viewportsForDevices(devices: readonly DeviceClass[]): ViewportSpec[] {
  return DEVICE_CLASSES
    .filter((device) => devices.includes(device.id))
    .flatMap((device) => device.viewports.map(parseViewport));
}

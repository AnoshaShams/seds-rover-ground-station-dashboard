export interface OdometryFields {
  x: number;
  y: number;
  /** degrees, [0, 360), counter-clockwise from +x */
  yawDeg: number;
  /** m/s, signed */
  speed: number;
  /** header stamp in ms since the epoch, sender's clock */
  stampMs: number;
  frameId: string;
  childFrameId: string;
}

export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function yawDegFromQuaternion(z: number, w: number): number;
export declare function convertOdometry(msg: unknown): OdometryFields | null;

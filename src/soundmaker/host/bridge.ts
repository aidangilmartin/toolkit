import type { GameInfo } from "../ipc";

export const BRIDGE_NAME = "gunpack-bridge";

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface ListResult {
  game: GameInfo;
  banks: { pack: string; file: string; size: number; archive: string }[];
}

export interface ExtractedBank {
  pack: string;
  file: string;
  path: string;
  streams: number;
  wasEncrypted: boolean;
  names: Record<string, string>;
}

export interface ScanResult {
  game: GameInfo;
  indexPath: string;
  /** sound-map.json: what every stream in WEAPONS_PLAYER / RESIDENT is for (see core/usage.ts). */
  mapPath: string;
  extracted: ExtractedBank[];
  errors: { pack: string; file: string; error: string }[];
  weapons: number;
  warnings: string[];
}

export interface ExtractResult {
  game: GameInfo;
  extracted: ExtractedBank[];
  errors: { pack: string; file: string; error: string }[];
}

export interface BuildRpfResult {
  game: GameInfo;
  archives: {
    pack: string;
    file: string;
    path: string;
    files: number;
    size: number;
    replaced: string[];
  }[];
  errors: { pack: string; file: string; error: string }[];
}

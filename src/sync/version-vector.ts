import type { DeviceId, VersionVector } from "../model";

export type VectorRelation = "equal" | "before" | "after" | "concurrent";

function count(vector: VersionVector, deviceId: string): number {
  const value = vector[deviceId];
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : 0;
}

export function compareVectors(left: VersionVector, right: VersionVector): VectorRelation {
  let leftGreater = false;
  let rightGreater = false;
  const deviceIds = new Set([...Object.keys(left), ...Object.keys(right)]);

  for (const deviceId of deviceIds) {
    const leftCount = count(left, deviceId);
    const rightCount = count(right, deviceId);
    if (leftCount > rightCount) leftGreater = true;
    if (rightCount > leftCount) rightGreater = true;
    if (leftGreater && rightGreater) return "concurrent";
  }

  if (leftGreater) return "after";
  if (rightGreater) return "before";
  return "equal";
}

export function mergeVectors(...vectors: VersionVector[]): VersionVector {
  const merged: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const vector of vectors) {
    for (const [deviceId, value] of Object.entries(vector)) {
      if (Number.isSafeInteger(value) && value > (merged[deviceId] ?? 0)) {
        merged[deviceId] = value;
      }
    }
  }
  return merged;
}

export function incrementVector(
  vector: VersionVector,
  deviceId: DeviceId,
  nextCounter: number
): VersionVector {
  if (!deviceId) throw new Error("Cannot increment a version vector without a device ID");
  if (!Number.isSafeInteger(nextCounter) || nextCounter <= count(vector, deviceId)) {
    throw new Error("The next device counter must be greater than its vector value");
  }
  return { ...vector, [deviceId]: nextCounter };
}

export function validateVector(value: unknown): value is VersionVector {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([deviceId, counter]) =>
      deviceId.length >= 8 &&
      deviceId.length <= 128 &&
      Number.isSafeInteger(counter) &&
      (counter as number) > 0
  );
}

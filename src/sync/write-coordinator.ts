import { resolve } from "node:path";

const activeWrites = new Map<string, number>();

export function runSingleFlightWrite<T>(
  projectRoot: string,
  operation: () => T,
  onCollision: () => T,
): T {
  const root = resolve(projectRoot);
  if ((activeWrites.get(root) ?? 0) > 0) {
    return onCollision();
  }

  activeWrites.set(root, 1);
  try {
    return operation();
  } finally {
    activeWrites.delete(root);
  }
}

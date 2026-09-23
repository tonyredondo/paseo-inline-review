export function buildClientBundle(options?: {
  check?: boolean;
}): Promise<{
  changed: boolean;
  bytes: number;
}>;

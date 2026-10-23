export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "1";
}

/** Timings are stored in minutes and entered as minutes, hours, days or weeks. */
export const DURATION_UNITS = [[10080, "Weeks"], [1440, "Days"], [60, "Hours"], [1, "Minutes"]] as const;

const words = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** The largest unit that shows the value exactly: 1440 is 1 day, 90 is 90 minutes. */
export function splitMinutes(minutes: number): { amount: number; unit: number } {
  const [unit] = DURATION_UNITS.find(([u]) => minutes % u === 0) ?? [1];
  return { amount: minutes / unit, unit };
}

/** An exact setting in words, such as "30 minutes" or "2 days". */
export function durationText(minutes: number): string {
  const { amount, unit } = splitMinutes(minutes);
  return words(amount, unit === 10080 ? "week" : unit === 1440 ? "day" : unit === 60 ? "hour" : "minute");
}

/** How long something has waited, rounded down to the largest whole unit. */
export function waitedText(minutes: number): string {
  if (minutes >= 1440) return words(Math.floor(minutes / 1440), "day");
  if (minutes >= 60) return words(Math.floor(minutes / 60), "hour");
  return words(minutes, "minute");
}

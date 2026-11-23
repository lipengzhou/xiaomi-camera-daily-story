const SHANGHAI_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function partsForShanghai(date: Date): { year: number; month: number; day: number } {
  const values = Object.fromEntries(
    SHANGHAI_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
  };
}

export function storyDateFromCreateTime(createTime: number): string {
  const generated = partsForShanghai(new Date(createTime));
  const previous = new Date(Date.UTC(generated.year, generated.month - 1, generated.day - 1));
  return [
    previous.getUTCFullYear().toString().padStart(4, "0"),
    (previous.getUTCMonth() + 1).toString().padStart(2, "0"),
    previous.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

export function compactDate(date: string): string {
  return date.replaceAll("-", "");
}

export function creationTime(date: string): string {
  return `${date}T23:59:59+08:00`;
}

export function expectedUtcCreationTime(date: string): string {
  return `${date}T15:59:59.000000Z`;
}

export function nextShanghaiRun(now: Date, time: string): Date {
  const [hourText, minuteText] = time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`Invalid schedule time: ${time}`);
  }
  const today = partsForShanghai(now);
  let timestamp = Date.UTC(today.year, today.month - 1, today.day, hour - 8, minute);
  if (timestamp <= now.getTime()) {
    timestamp += 24 * 60 * 60 * 1000;
  }
  return new Date(timestamp);
}

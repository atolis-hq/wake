export function formatLocalTime(value: string, locale?: string, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat(locale ?? 'en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
export function LocalTime({
  value,
  locale,
  timeZone,
}: {
  readonly value: string;
  readonly locale?: string;
  readonly timeZone?: string;
}) {
  return (
    <time
      dateTime={value}
      title={value}
      aria-label={`${formatLocalTime(value, locale, timeZone)}; exact UTC ${value}`}
    >
      {formatLocalTime(value, locale, timeZone)}
    </time>
  );
}

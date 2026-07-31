export function formatLocalTime(value: string, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(value));
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

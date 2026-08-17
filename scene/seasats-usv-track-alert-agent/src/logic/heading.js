export function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Customer rule: heading is primary; only its exact 511 error marker falls
// back to orientation. A second 511 marker means no direction is available.
export function resolveHeadingValue(value) {
  const heading = numberOrNull(value?.headingDeg ?? value?.heading);
  const orientationValue = Object.hasOwn(value || {}, "orientation")
    ? value.orientation
    : value?.courseDeg;
  const orientation = numberOrNull(orientationValue);

  if (heading === 511) return orientation === 511 ? null : orientation;

  const resolved = heading ?? orientation;
  return resolved === 511 ? null : resolved;
}

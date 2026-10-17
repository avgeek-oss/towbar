export function canKeepQueryData(
  previousPath: string,
  path: string | null,
  keepPreviousData: boolean,
) {
  return (
    keepPreviousData &&
    path !== null &&
    previousPath.split("?")[0] === path.split("?")[0]
  );
}

export function canUseStaleData(status?: number) {
  return (
    status === undefined || status === 408 || status === 429 || status >= 500
  );
}

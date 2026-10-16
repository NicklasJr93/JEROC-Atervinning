/** Identity equivalence only for denying self-approval; it never grants rights. */
export function isSelfOwned(
  recordedUserIds: readonly (string | undefined)[],
  currentUserIds: readonly (string | undefined)[],
  selfBusinessUserIds: readonly string[] = [],
): boolean {
  return recordedUserIds.some(recorded => {
    if (!recorded) return false;
    return currentUserIds.some(current => {
      if (!current) return false;
      return recorded === current || selfBusinessUserIds.includes(recorded) && selfBusinessUserIds.includes(current);
    });
  });
}

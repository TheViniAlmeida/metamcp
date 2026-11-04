/**
 * Whether the current user may set `requested` as the owner of a resource.
 * Leaving it out, claiming it for yourself or making it public (null) is
 * fine; handing it to another user is not, since that plants keys, servers,
 * namespaces or endpoints that run as someone else.
 */
export function canAssignOwner(
  requested: string | null | undefined,
  currentUserId: string,
): boolean {
  return (
    requested === undefined || requested === null || requested === currentUserId
  );
}

/**
 * Whether an update may move a resource from `existingOwner` to `requested`.
 * Keeping the owner is always fine and an owner may make their resource
 * public, but a shared (public) resource is never claimed by whoever edits
 * it, and nothing is handed to another user.
 */
export function canChangeOwner(
  requested: string | null | undefined,
  currentUserId: string,
  existingOwner: string | null,
): boolean {
  if (requested === undefined || requested === existingOwner) {
    return true;
  }
  return requested === null && existingOwner === currentUserId;
}

export const OWNER_DENIED_MESSAGE =
  "Access denied: You can only assign resources to yourself or make them public";

export const OWNER_CHANGE_DENIED_MESSAGE =
  "Access denied: Ownership can only be kept, or made public by its owner";

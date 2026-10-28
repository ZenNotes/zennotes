import {
  describeCloudError,
  type CloudErrorCopy,
} from "@zennotes/shared-domain/cloud-error-copy";
import { signOutAfterRefusal } from "../lib/cloud-auto-sync";
import { ErrorDetails } from "./ErrorDetails";

/**
 * A failed Cloud action in words a person can act on. The desktop main
 * process words its errors before IPC and appends the technical line; the
 * phones' in-process hosts hand over the error itself. Either way the result
 * is the sentence to show and, apart from it, the line support needs.
 */
export function cloudErrorCopy(
  error: unknown,
  fallback: string,
  /** Given, a refused sign-in also signs this device out, as sync does. */
  bridge?: Parameters<typeof signOutAfterRefusal>[0],
): CloudErrorCopy {
  const copy = describeCloudError(error, fallback);
  if (bridge && copy.kind === "signed-out") signOutAfterRefusal(bridge, copy);
  return copy;
}

/**
 * The sentence, and under it a closed Details disclosure with the technical
 * line, Copy details, and Report an Issue (the same words as the Help menu
 * and the command palette). The surrounding alert box belongs to the caller.
 */
export function CloudErrorMessage({
  message,
  detail,
}: {
  message: string;
  detail: string | null;
}): JSX.Element {
  return (
    <>
      <span data-cloud-error-message="">{message}</span>
      {detail && <ErrorDetails detail={detail} data-cloud-error-details="" />}
    </>
  );
}

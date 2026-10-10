import { APIError } from "better-auth/api";
import { NAME_NOT_ALLOWED, reviewDisplayName } from "../security/display-name.js";

// The auth library's database hooks see every account name it stores, so
// this is the one enforcement point for email sign-up, social sign-in import
// and the update-user endpoint. A name the user typed is refused with a 400;
// a name imported from a social profile is dropped, and sign-in goes on.
const REFUSING_PATHS = new Set(["/sign-up/email", "/update-user"]);

async function guardName(data, context) {
  if (typeof data?.name !== "string" || !data.name.trim()) return undefined;
  const verdict = await reviewDisplayName(data.name);
  if (verdict.allowed) return undefined;
  if (REFUSING_PATHS.has(context?.path)) {
    throw new APIError("BAD_REQUEST", { code: NAME_NOT_ALLOWED.code, message: NAME_NOT_ALLOWED.error });
  }
  return { data: { ...data, name: "" } };
}

export const displayNameHooks = {
  user: {
    create: { before: guardName },
    update: { before: guardName },
  },
};

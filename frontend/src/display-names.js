// Which name each part of the workspace shows. The server withholds a stored
// name that fails its name check (it sends user.nameWithheld, and
// user.preferredNameWithheld for the survey's "Call me" name). The app then
// falls back to the email's local part, and the greeting drops the name.
export const NAMELESS_GREETING = "Ready when you are.";

export function workspaceNames(user, onboarding) {
  const emailName = String(user?.email ?? "").split("@")[0];
  const accountName = user?.name?.trim() || "";
  const preferredName = user?.preferredNameWithheld ? "" : onboarding?.preferred_name || "";
  const displayName = accountName || emailName;
  return {
    displayName,
    // The name chosen in the survey wins over the account name in greetings.
    greetingName: preferredName || (user?.nameWithheld ? "" : displayName.split(/\s+/)[0]),
    surveyName: preferredName || accountName.split(/\s+/)[0] || "",
    settingsName: accountName || (user?.nameWithheld ? emailName : "Not set"),
    settingsCallMe: preferredName || (user?.preferredNameWithheld ? emailName : "Not answered"),
  };
}

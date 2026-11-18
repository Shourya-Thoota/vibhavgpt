// The words and rules for an upload whose result never came back. Plain functions so they can be tested without rendering the card.

/** True for an action the person can settle by checking their own Drive. */
export function canReconcile(action) {
  return action?.status === "uncertain" && action?.toolName === "google_drive_upload_file";
}

export const UNKNOWN_TITLE = "Upload status unknown";

export function unknownBody(action) {
  const payload = action?.payload || {};
  const file = payload.fileName ? `“${payload.fileName}”` : "the file";
  const where = payload.folderName || "My Drive";
  const account = payload.accountLabel ? ` (${payload.accountLabel})` : "";
  return {
    summary: `We couldn't confirm whether ${file} reached Google Drive. It was not sent again.`,
    warning: "Trying again straight away could create a duplicate if the first attempt actually worked.",
    steps: [
      `Open your Google Drive${account} and look in ${where} for ${file}.`,
      "Then tell us what you found. We will not upload anything until you say so and approve a new request.",
    ],
  };
}

export const FOUND_LABEL = "I found the uploaded file";
export const NOT_FOUND_LABEL = "I checked; it was not uploaded";

export const NOT_UPLOADED_CONFIRM = {
  title: "Confirm: the file is not in your Drive?",
  body: "This lets you ask for a new upload, which you will approve separately. If the first upload did actually succeed, a second one would create a duplicate file. Nothing is uploaded now.",
  confirm: "Yes, it was not uploaded",
  cancel: "Go back",
};

/** What a settled action says about itself. These are the person's own words recorded, never something Google Drive confirmed. */
export function settledText(action) {
  const reconciled = action?.result?.reconciled;
  if (reconciled === "uploaded") {
    return { title: "Marked as uploaded by you", body: "You told us this file is in your Google Drive. Google Drive did not confirm it to us, so we have no link. It will not be uploaded again." };
  }
  if (reconciled === "not_uploaded") {
    return { title: "Marked as not uploaded by you", body: "You told us this file did not reach your Google Drive. Nothing was sent again. If you still want it there, ask for it again and approve that new request." };
  }
  return null;
}

// What a successful connector read looks like to the model.
//
// Composio documents a tool's `data` output as a string, while some tools
// return an object. Either way the provider's own fields must reach the model
// readable, because that is where an answer such as a channel's title lives.
//   object data -> used as it is
//   string data that holds JSON -> parsed, so the model reads real JSON and not
//                                  a JSON document escaped inside a string
//   anything else -> left alone
// The result is capped so one large response cannot crowd out the conversation.

export const CONNECTOR_RESULT_LIMIT = 12_000;

export function unwrapProviderData(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.data === "string") {
    try {
      const parsed = JSON.parse(payload.data);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Not JSON: the string is the data.
    }
  }
  return payload;
}

export function connectorResultContent(payload, serviceName) {
  const data = unwrapProviderData(payload);
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2).slice(0, CONNECTOR_RESULT_LIMIT);
  return content || `${serviceName} returned an empty result.`;
}

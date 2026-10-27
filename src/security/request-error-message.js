// What a client is told when the HTTP body parser rejects its request. The parser's own
// message can quote the request back: the first characters of the body, or the value of a
// header the client sent (an unsupported charset or content encoding). A fixed sentence per
// kind of failure says what went wrong without repeating anything the client sent. The
// status code is the parser's own and is not changed here. Errors the routes raise on
// purpose carry their own documented messages and are not touched.
const MESSAGES = {
  "entity.parse.failed": "The request body is not valid JSON.",
  "entity.too.large": "The request body is too large.",
  "entity.verify.failed": "The request body could not be verified.",
  "request.aborted": "The request was cancelled before it finished.",
  "request.size.invalid": "The request body did not match its declared size.",
  "stream.encoding.set": "The request could not be read.",
  "encoding.unsupported": "The request's content encoding is not supported.",
  "charset.unsupported": "The request's character set is not supported.",
  "parameters.too.many": "The request has too many parameters.",
  "querystring.parse.rangeError": "The request could not be read.",
};

export function parserFailureMessage(error) {
  return typeof error?.type === "string" && Object.hasOwn(MESSAGES, error.type) ? MESSAGES[error.type] : null;
}

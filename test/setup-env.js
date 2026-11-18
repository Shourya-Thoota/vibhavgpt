// Loaded before every test file (see the "test" script). Tests run against
// placeholder endpoints, models and routes, never real configuration, and
// every request in them goes to a fake fetch.
import "dotenv/config";

const fixtures = {
  INFERENCE_PRIMARY_BASE_URL: "https://primary.test/v1",
  INFERENCE_GATEWAY_BASE_URL: "https://gateway.test/v1",
  INFERENCE_SECONDARY_BASE_URL: "https://secondary.test/v1",
  INFERENCE_RESERVE_BASE_URL: "https://reserve.test/v1",
  INFERENCE_ROUTER_BASE_URL: "https://router.test/api/v1",
  INFERENCE_ROUTER_API_KEY: "test-router-key",
  INFERENCE_DIRECT_BASE_URL: "https://direct.test/v1",
  INFERENCE_DIRECT_API_KEY: "test-direct-key",
  CHAT_NOVA_ROUTE_PROVIDERS: "route-a/fp4,route-b,route-c/fp4,route-d/fp8,route-e/fp8",
  CHAT_NEBULA_ROUTE_PROVIDERS: "route-f/int4,route-g,route-a/fp4,route-h/fp8,route-i/fp4",
  MODERATION_API_URL: "https://primary.test/v1/chat/completions",
  MODERATION_MODEL: "fixture/moderation",
  MEMORY_EXTRACTION_MODEL: "fixture/memory",
  IMAGE_GENERATION_MODEL: "fixture/image",
  VOICE_REALTIME_MODEL: "fixture-realtime",
  VOICE_TRANSCRIPTION_MODEL: "fixture-transcribe",
  SEARCH_API_URL: "https://search.test/search",
  WEATHER_API_URL: "https://weather.test/data/2.5/weather",
  WEATHER_SOURCE_NAME: "Fixture Weather",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:9/unused",
  // The suites written for Lumen's four-stage chain test it as the rollback route (CHAT_LUMEN_ROUTE=staged). Production defaults to
  // the pinned gateway route; test/lumen-gateway.test.js and test/unified-memory.test.js set that route explicitly.
  CHAT_LUMEN_ROUTE: "staged",
  // The shared capacity layer keeps its leases in Postgres; the suites that predate it use fake databases, so it is off for them.
  // test/chat-capacity.test.js and test/browser-chat-capacity.test.js turn it on over a real (PGlite) database.
  CHAT_CAPACITY: "off",
};
for (const [name, value] of Object.entries(fixtures)) process.env[name] = value;
// Test-only session secret, so a test that imports the auth module without setting its own does not depend on a local .env file.
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";
// The name guards use the real list when one is configured locally.
process.env.PROVIDER_NAME_TERMS ||= "examplevendor,example router,fixturemodel";
// Made-up placeholder terms for the display-name tests: one short (whole-word
// only), one long (also matched inside longer words), one of two words, and
// two with double letters (one short, one long). Always these, never a real
// list.
process.env.NAME_BLOCKLIST = "grux,zorblax,snarf blat,zzoo,quobbllefrozz";
// Existing tests use synthetic users and accounts; this lets them keep working without a grant for each. It has no effect unless this flag is set,
// and the tests that check ownership do not set a wildcard.
process.env.COMPOSIO_GRANTS_ALLOW_WILDCARD_FOR_TESTS ||= "true";
process.env.COMPOSIO_CONSUMER_ACCOUNT_GRANTS ||= JSON.stringify({ "*": ["*"] });

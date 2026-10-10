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
  INFERENCE_DIRECT_BASE_URL: "https://direct.test/v1",
  CHAT_NOVA_ROUTE_PROVIDERS: "route-a/fp4,route-b,route-c/fp4,route-d/fp8,route-e/fp8",
  CHAT_NEBULA_ROUTE_PROVIDERS: "route-f/int4,route-g,route-a/fp4,route-h/fp8,route-i/fp4",
  MODERATION_API_URL: "https://primary.test/v1/chat/completions",
  MODERATION_MODEL: "fixture/moderation",
  MEMORY_EXTRACTION_MODEL: "fixture/memory",
  IMAGE_GENERATION_MODEL: "fixture/image",
  VOICE_REALTIME_MODEL: "fixture-realtime",
  VOICE_TRANSCRIPTION_MODEL: "fixture-transcribe",
  VOICE_NAME: "fixture-voice",
  SEARCH_API_URL: "https://search.test/search",
  WEATHER_API_URL: "https://weather.test/data/2.5/weather",
  WEATHER_SOURCE_NAME: "Fixture Weather",
};
for (const [name, value] of Object.entries(fixtures)) process.env[name] = value;
// The name guards use the real list when one is configured locally.
process.env.PROVIDER_NAME_TERMS ||= "examplevendor,example router,fixturemodel";

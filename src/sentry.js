import * as Sentry from "@sentry/node";
import { config } from "./config.js";

if (config.sentryDsn) {
  Sentry.init({ dsn: config.sentryDsn, environment: config.environment });
}

export { Sentry };
